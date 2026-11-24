import type { Pool, PoolClient } from "pg";
import type { Membership } from "../auth/authorizeTenantAccess";
import type { Book } from "../catalog/registerBook";
import { AppError } from "../errors/AppError";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import type { Order, OrderLine } from "../order/createDraftOrder";
import { createOrderApi } from "../order/orderApi";

/** 풀에서 연결을 빌려 쓰는 최소 인터페이스 (pg.Pool과 호환) */
export type PoolLike = Pick<Pool, "connect">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

type OrderRow = {
  id: string;
  tenant_id: string;
  status: "DRAFT" | "CONFIRMED";
  version: string;
  display_number: string | null;
  total_krw: string | null;
  created_at: Date;
  closed_at: Date | null;
  cancelled_at: Date | null;
};
type LineRow = {
  id: string;
  order_id: string;
  book_key: string;
  quantity: number;
  unit_price_krw: string;
  book_title: string | null;
  book_isbn: string | null;
  list_price_krw: string | null;
};

function toOrder(row: OrderRow, lines: LineRow[]): Order {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    lines: lines.map(
      (l): OrderLine => ({
        lineId: l.id,
        bookId: l.book_key,
        quantity: l.quantity,
        unitPriceKrw: l.unit_price_krw,
        ...(l.book_title === null ? {} : { bookTitle: l.book_title }),
        ...(l.book_isbn === null ? {} : { bookIsbn: l.book_isbn }),
        ...(l.list_price_krw === null ? {} : { listPriceKrw: l.list_price_krw }),
      }),
    ),
    ...(row.total_krw === null ? {} : { totalKrw: row.total_krw }),
    ...(row.display_number === null ? {} : { displayNumber: Number(row.display_number) }),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at.toISOString() }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at.toISOString() }),
  };
}

async function loadOrders(
  client: PoolClient,
  tenantId: string,
  options: { orderId?: string; lock?: boolean },
): Promise<Order[]> {
  if (!isUuid(tenantId) || (options.orderId !== undefined && !isUuid(options.orderId))) return [];
  const orders = (
    await client.query<OrderRow>(
      `select * from public.ordering_orders where tenant_id = $1 ${options.orderId === undefined ? "" : "and id = $2"} ${
        options.lock ? "for update" : ""
      }`,
      options.orderId === undefined ? [tenantId] : [tenantId, options.orderId],
    )
  ).rows;
  if (orders.length === 0) return [];
  const lines = (
    await client.query<LineRow>(
      "select * from public.ordering_order_lines where tenant_id = $1 and order_id = any($2::uuid[]) order by order_id, position",
      [tenantId, orders.map((o) => o.id)],
    )
  ).rows;
  return orders.map((o) =>
    toOrder(
      o,
      lines.filter((l) => l.order_id === o.id),
    ),
  );
}

async function loadBooks(client: PoolClient, tenantId: string, bookIds: string[]): Promise<Book[]> {
  if (!isUuid(tenantId) || bookIds.length === 0) return [];
  const rows = (
    await client.query(
      "select * from public.ordering_books where tenant_id = $1 and id::text = any($2::text[])",
      [tenantId, bookIds],
    )
  ).rows;
  return rows.map(
    (b): Book => ({
      id: b.id,
      tenantId: b.tenant_id,
      title: b.title,
      authors: b.authors,
      ...(b.isbn === null ? {} : { isbn: b.isbn }),
      listPriceKrw: b.list_price_krw,
      source: b.source,
      ...(b.external_id === null ? {} : { externalId: b.external_id }),
      ...(b.fetched_at === null ? {} : { fetchedAt: b.fetched_at.toISOString() }),
      ...(b.manual_reason === null ? {} : { manualReason: b.manual_reason }),
      status: b.status,
      version: Number(b.version),
      createdBy: b.created_by,
      createdAt: b.created_at.toISOString(),
      recordedAt: b.recorded_at.toISOString(),
    }),
  );
}

async function loadMembership(client: PoolClient, userId: string, tenantId: string): Promise<Membership[]> {
  if (!isUuid(userId) || !isUuid(tenantId)) return [];
  const rows = (
    await client.query("select user_id, tenant_id, role, active from public.ordering_members where user_id = $1 and tenant_id = $2", [
      userId,
      tenantId,
    ])
  ).rows;
  return rows.map((r) => ({
    userId: r.user_id,
    tenantId: r.tenant_id,
    role: r.role,
    status: r.active ? "ACTIVE" : "INACTIVE",
  }));
}

const commandKey = (tenantId: string, operation: string, key: string) => JSON.stringify([tenantId, operation, key]);

async function loadCommands(client: PoolClient, tenantId: string, key: unknown): Promise<IdempotencyStore> {
  const store: IdempotencyStore = new Map();
  if (!isUuid(tenantId) || typeof key !== "string" || key.trim() === "") return store;
  const rows = (
    await client.query("select operation, command_key, payload_hash, result from public.ordering_commands where tenant_id = $1 and command_key = $2", [
      tenantId,
      key,
    ])
  ).rows;
  for (const r of rows) {
    store.set(commandKey(tenantId, r.operation, r.command_key), { payloadHash: r.payload_hash, result: r.result });
  }
  return store;
}

async function saveOrder(client: PoolClient, order: Order, before: Order | undefined): Promise<void> {
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
        set status = $3, version = $4, display_number = $5, total_krw = $6, closed_at = $7, cancelled_at = $8
      where tenant_id = $1 and id = $2 and version = $9`,
    [order.tenantId, order.id, order.status, order.version, order.displayNumber ?? null, order.totalKrw ?? null, order.closedAt ?? null, order.cancelledAt ?? null, before.version],
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
 * 기존 동기 `createOrderApi`를 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 요청마다 한 트랜잭션에서 멤버십·주문(쓰기는 행 잠금)·멱등 기록·도서를 적재하고, 도메인을 그대로 실행한 뒤,
 * 변경분을 같은 트랜잭션에 저장한다. 쓰기는 `service_role`, 읽기는 `authenticated`+JWT 클레임(RLS 경유)로 실행한다.
 * 호출자는 풀이 승인된 DB를 가리키는지 책임진다.
 */
export function createPgOrderApi(deps: { pool: PoolLike }) {
  async function inTransaction<T>(role: "service_role" | "authenticated", userId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect();
    try {
      await client.query("begin");
      try {
        await client.query(`set local role ${role}`);
        if (role === "authenticated") {
          await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
        }
        const result = await run(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  const isCommandKeyConflict = (error: unknown) =>
    (error as { code?: string; constraint?: string }).code === "23505" &&
    (error as { constraint?: string }).constraint === "ordering_commands_pkey";

  async function write<T>(
    actor: Actor,
    request: { tenantId: string; idempotencyKey?: unknown; orderId?: string; lines?: { bookId?: unknown }[] },
    options: { confirm: boolean },
    call: (api: ReturnType<typeof createOrderApi>) => T,
  ): Promise<T> {
    // 같은 멱등 키가 동시에 들어오면 한쪽의 저장이 유일 제약에 걸린다. 한 번 다시 시도하면 먼저 저장된 결과를 본다
    for (let attempt = 0; ; attempt++) {
      try {
        return await inTransaction("service_role", actor.userId, async (client) => {
          const memberships = await loadMembership(client, actor.userId, request.tenantId);
          const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
          const knownCommands = new Set(idempotency.keys());
          const loaded = await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: options.confirm });
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
          for (const [storeKey, entry] of idempotency) {
            if (knownCommands.has(storeKey)) continue;
            const [tenantId, operation, key] = JSON.parse(storeKey) as [string, string, string];
            await client.query(
              "insert into public.ordering_commands (tenant_id, operation, command_key, payload_hash, result) values ($1, $2, $3, $4, $5::jsonb)",
              [tenantId, operation, key, entry.payloadHash, JSON.stringify(entry.result)],
            );
          }
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
  ): Promise<T> {
    // 읽기는 authenticated 역할로 실행해 RLS가 서점·활성 멤버십을 한 번 더 걸러 준다
    const userId = isUuid(actor.userId) ? actor.userId : "";
    return inTransaction(userId === "" ? "service_role" : "authenticated", userId, async (client) => {
      const memberships = userId === "" ? [] : await loadMembership(client, userId, request.tenantId);
      const loaded = userId === "" ? [] : await loadOrders(client, request.tenantId, { orderId: request.orderId });
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
    listOrders: (actor: Actor, request: Parameters<ReturnType<typeof createOrderApi>["listOrders"]>[1]) =>
      read(actor, request, (api) => api.listOrders(actor, request)),
  };
}
