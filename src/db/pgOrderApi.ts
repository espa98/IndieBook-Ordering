import type { PoolClient } from "pg";
import type { Book } from "../catalog/registerBook";
import { AppError } from "../errors/AppError";
import type { Order } from "../order/createDraftOrder";
import { DEFAULT_LIMIT, MAX_LIMIT, ORDER_STATUSES, decodeCursor } from "../order/listOrders";
import { createOrderApi } from "../order/orderApi";
import {
  inTransaction,
  isCommandKeyConflict,
  isUuid,
  loadCommands,
  loadMembership,
  loadOrders,
  type OrderPage,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";
import { toBook } from "./pgCatalogApi";

export type { PoolLike } from "./pgSupport";

async function loadBooks(client: PoolClient, tenantId: string, bookIds: string[]): Promise<Book[]> {
  if (!isUuid(tenantId) || bookIds.length === 0) return [];
  const rows = (
    await client.query(
      "select * from public.ordering_books where tenant_id = $1 and id::text = any($2::text[])",
      [tenantId, bookIds],
    )
  ).rows;
  return rows.map(toBook);
}

export async function saveOrder(client: PoolClient, order: Order, before: Order | undefined): Promise<void> {
  if (before === undefined) {
    await client.query(
      `insert into public.ordering_orders (id, tenant_id, status, version, display_number, total_krw, created_at, closed_at, cancelled_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [order.id, order.tenantId, order.status, order.version, order.displayNumber ?? null, order.totalKrw ?? null, order.createdAt, order.closedAt ?? null, order.cancelledAt ?? null],
    );
    for (const [index, line] of order.lines.entries()) {
      await client.query(
        `insert into public.ordering_order_lines (id, tenant_id, order_id, position, book_key, quantity, unit_price_krw, book_title, book_isbn, list_price_krw)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [line.lineId, order.tenantId, order.id, index + 1, line.bookId, line.quantity, line.unitPriceKrw, line.bookTitle ?? null, line.bookIsbn ?? null, line.listPriceKrw ?? null],
      );
    }
    return;
  }
  // 적재한 version과 같을 때만 갱신한다. 다르면 다른 세션이 먼저 바꾼 것이다
  const updated = await client.query(
    `update public.ordering_orders
        set status = $3, version = $4, display_number = $5, total_krw = $6, closed_at = $7, cancelled_at = $8,
            held_at = $10, hold_reason = $11, held_by = $12, discarded_at = $13, discard_reason = $14, discarded_by = $15
      where tenant_id = $1 and id = $2 and version = $9`,
    [
      order.tenantId, order.id, order.status, order.version, order.displayNumber ?? null, order.totalKrw ?? null, order.closedAt ?? null, order.cancelledAt ?? null, before.version,
      order.heldAt ?? null, order.holdReason ?? null, order.heldBy ?? null, order.discardedAt ?? null, order.discardReason ?? null, order.discardedBy ?? null,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new AppError("VERSION_CONFLICT");
  }
  for (const line of order.lines) {
    const previous = before.lines.find((l) => l.lineId === line.lineId);
    if (previous && previous.quantity !== line.quantity) {
      await client.query("update public.ordering_order_lines set quantity = $3 where tenant_id = $1 and id = $2", [order.tenantId, line.lineId, line.quantity]);
    }
  }
}

type Actor = { userId: string };

/**
 * 목록 요청을 SQL 페이지로 바꾼다. 형식이 틀린 요청(한도·상태·커서)과 DB에 있을 수 없는 커서는 "none"이다:
 * 도메인이 인증을 확인한 뒤 같은 검증 오류로 거부하므로 순서가 전과 같고, 전체 적재를 강제할 수도 없다.
 */
function pageOf(request: { limit?: number; cursor?: string; status?: Order["status"] }): OrderPage | "none" {
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return "none";
  if (request.status !== undefined && !ORDER_STATUSES.includes(request.status)) return "none";
  let after: OrderPage["after"];
  if (request.cursor !== undefined) {
    try {
      const key = decodeCursor(request.cursor);
      const canonical = !Number.isNaN(Date.parse(key.createdAt)) && new Date(key.createdAt).toISOString() === key.createdAt;
      if (!canonical || !isUuid(key.id)) return "none";
      after = key;
    } catch {
      return "none";
    }
  }
  return { limit, ...(request.status !== undefined ? { status: request.status } : {}), ...(after ? { after } : {}) };
}

/**
 * 기존 동기 `createOrderApi`를 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 요청마다 한 트랜잭션에서 멤버십·주문(쓰기는 행 잠금)·멱등 기록·도서를 적재하고, 도메인을 그대로 실행한 뒤,
 * 변경분을 같은 트랜잭션에 저장한다. 쓰기는 `service_role`, 읽기는 `authenticated`+JWT 클레임(RLS 경유)로 실행한다.
 * 호출자는 풀이 승인된 DB를 가리키는지 책임진다.
 */
export function createPgOrderApi(deps: { pool: PoolLike }) {
  async function write<T>(
    actor: Actor,
    request: { tenantId: string; idempotencyKey?: unknown; orderId?: string; lines?: { bookId?: unknown }[] },
    options: { confirm: boolean; lock?: boolean },
    call: (api: ReturnType<typeof createOrderApi>) => T,
  ): Promise<T> {
    // 같은 멱등 키가 동시에 들어오면 한쪽의 저장이 유일 제약에 걸린다. 한 번 다시 시도하면 먼저 저장된 결과를 본다
    for (let attempt = 0; ; attempt++) {
      try {
        return await inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
          const memberships = await loadMembership(client, actor.userId, request.tenantId);
          const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
          const knownCommands = new Set(idempotency.keys());
          // 주문 생성은 기존 주문을 읽지 않는다(새 주문을 저장만 한다). 대상 주문이 있는 명령만 그 주문을 적재한다
          const loaded = request.orderId === undefined ? [] : await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: options.confirm || options.lock ? "update" : undefined });
          const bookIds = (Array.isArray(request.lines) ? request.lines : [])
            .map((l) => (l && typeof l === "object" ? l.bookId : undefined))
            .filter((id): id is string => typeof id === "string");
          const books = await loadBooks(client, request.tenantId, bookIds);

          let counter = 0;
          const counterStart = 0;
          if (options.confirm && isUuid(request.tenantId) && memberships.length > 0) {
            await client.query("insert into public.ordering_counters (tenant_id) values ($1) on conflict do nothing", [request.tenantId]);
            counter = Number((await client.query("select order_number from public.ordering_counters where tenant_id = $1 for update", [request.tenantId])).rows[0].order_number);
          }

          const before = new Map(loaded.map((o) => [o.id, o]));
          const saved = new Map<string, Order>();
          const api = createOrderApi({
            orders: {
              get: (tenantId, orderId) => saved.get(orderId) ?? before.get(orderId),
              list: (tenantId) => [...loaded].filter((o) => o.tenantId === tenantId),
              save: (order) => void saved.set(order.id, order),
            },
            books: { get: (tenantId, id) => books.find((b) => b.tenantId === tenantId && b.id === id) },
            memberships: { find: (userId, tenantId) => memberships.find((m) => m.userId === userId && m.tenantId === tenantId) },
            idempotency,
            issueDisplayNumber: () => ++counter,
          });
          const result = call(api);

          for (const order of saved.values()) {
            await saveOrder(client, order, before.get(order.id));
          }
          if (counter !== counterStart && options.confirm) {
            await client.query("update public.ordering_counters set order_number = $2 where tenant_id = $1", [request.tenantId, counter]);
          }
          await saveNewCommands(client, idempotency, knownCommands);
          return result;
        });
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        throw error;
      }
    }
  }

  async function read<T>(
    actor: Actor,
    request: { tenantId: string; orderId?: string },
    call: (api: ReturnType<typeof createOrderApi>) => T,
    /** 목록 읽기: 한 페이지만 SQL로 적재한다. "none"이면 적재하지 않는다(요청이 잘못돼 도메인이 권한 확인 뒤 거부한다) */
    page?: OrderPage | "none",
  ): Promise<T> {
    // 읽기는 authenticated 역할로 실행해 RLS가 서점·활성 멤버십을 한 번 더 걸러 준다
    const userId = isUuid(actor.userId) ? actor.userId : "";
    return inTransaction(deps.pool, userId === "" ? "service_role" : "authenticated", userId, async (client) => {
      const memberships = userId === "" ? [] : await loadMembership(client, userId, request.tenantId);
      const loaded = userId === "" || page === "none" ? [] : await loadOrders(client, request.tenantId, { orderId: request.orderId, ...(page ? { page } : {}) });
      const api = createOrderApi({
        orders: {
          get: (tenantId, orderId) => loaded.find((o) => o.id === orderId && o.tenantId === tenantId),
          list: (tenantId) => loaded.filter((o) => o.tenantId === tenantId),
          save: () => {
            throw new Error("read path must not save");
          },
        },
        books: { get: () => undefined },
        memberships: { find: (u, t) => memberships.find((m) => m.userId === u && m.tenantId === t) },
        idempotency: new Map(),
        issueDisplayNumber: () => {
          throw new Error("read path must not issue numbers");
        },
      });
      return call(api);
    });
  }

  return {
    createOrder: (actor: Actor, request: Parameters<ReturnType<typeof createOrderApi>["createOrder"]>[1]) =>
      write(actor, request, { confirm: false }, (api) => api.createOrder(actor, request)),
    confirmOrder: (actor: Actor, request: Parameters<ReturnType<typeof createOrderApi>["confirmOrder"]>[1]) =>
      write(actor, request, { confirm: true }, (api) => api.confirmOrder(actor, request)),
    getOrder: (actor: Actor, request: { tenantId: string; orderId: string }) =>
      read(actor, request, (api) => api.getOrder(actor, request)),
    holdOrder: (actor: Actor, request: Parameters<ReturnType<typeof createOrderApi>["holdOrder"]>[1]) =>
      write(actor, request, { confirm: false, lock: true }, (api) => api.holdOrder(actor, request)),
    resumeOrder: (actor: Actor, request: Parameters<ReturnType<typeof createOrderApi>["resumeOrder"]>[1]) =>
      write(actor, request, { confirm: false, lock: true }, (api) => api.resumeOrder(actor, request)),
    discardOrder: (actor: Actor, request: Parameters<ReturnType<typeof createOrderApi>["discardOrder"]>[1]) =>
      write(actor, request, { confirm: false, lock: true }, (api) => api.discardOrder(actor, request)),
    listOrders: (actor: Actor, request: Parameters<ReturnType<typeof createOrderApi>["listOrders"]>[1]) =>
      read(actor, request, (api) => api.listOrders(actor, request), pageOf(request)),
  };
}
