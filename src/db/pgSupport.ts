import type { Pool, PoolClient } from "pg";
import { currentAudit } from "./auditContext";
import { authorizeTenantAccess, type Membership } from "../auth/authorizeTenantAccess";
import type { UserPrincipal } from "../auth/principal";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import type { Order, OrderLine } from "../order/createDraftOrder";

/** 풀에서 연결을 빌려 쓰는 최소 인터페이스 (pg.Pool과 호환) */
export type PoolLike = Pick<Pool, "connect">;
export type DbRole = "service_role" | "authenticated";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/**
 * 한 트랜잭션에서 지정한 DB 역할로 실행한다. `authenticated`면 JWT 클레임의 sub를 설정해 RLS가 적용된다.
 * 실패하면 롤백한다.
 */
export async function inTransaction<T>(
  pool: PoolLike,
  role: DbRole,
  userId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query(`set local role ${role}`);
      if (role === "authenticated") {
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
      }
      const result = await run(client);
      // 감사 행은 명령과 같은 트랜잭션이다: 저장에 실패하면 명령도 롤백된다
      const audit = currentAudit();
      if (audit) {
        await client.query("insert into public.ordering_audit_log (tenant_id, actor_id, operation, command_key, request_hash, targets) values ($1, $2, $3, $4, $5, $6::jsonb)", [
          audit.tenantId ?? null,
          audit.actorId,
          audit.operation,
          audit.commandKey ?? null,
          audit.requestHash,
          JSON.stringify(audit.targets),
        ]);
      }
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

/** 같은 멱등 키가 동시에 들어와 유일 제약에 걸린 경우(먼저 저장된 결과를 다시 읽으면 된다) */
export function isCommandKeyConflict(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e.code === "23505" && e.constraint === "ordering_commands_pkey";
}

export async function loadMembership(client: PoolClient, userId: string, tenantId: string): Promise<Membership[]> {
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

/** 멤버십으로 주체를 만든다. 인증 없음·비멤버·비활성은 도메인과 같은 오류를 낸다 */
export function principalFor(memberships: Membership[], userId: string, tenantId: string): UserPrincipal {
  const { role } = authorizeTenantAccess(
    { memberships: { find: (u, t) => memberships.find((m) => m.userId === u && m.tenantId === t) } },
    { userId, tenantId },
  );
  return { kind: "USER", userId, tenantId, role };
}

const commandKey = (tenantId: string, operation: string, key: string) => JSON.stringify([tenantId, operation, key]);

export async function loadCommands(client: PoolClient, tenantId: string, key: unknown): Promise<IdempotencyStore> {
  const store: IdempotencyStore = new Map();
  if (!isUuid(tenantId) || typeof key !== "string" || key.trim() === "") return store;
  const rows = (
    await client.query(
      "select operation, command_key, payload_hash, result from public.ordering_commands where tenant_id = $1 and command_key = $2",
      [tenantId, key],
    )
  ).rows;
  for (const r of rows) {
    store.set(commandKey(tenantId, r.operation, r.command_key), { payloadHash: r.payload_hash, result: r.result });
  }
  return store;
}

/** 이번 요청에서 새로 생긴 멱등 기록만 저장한다 */
export async function saveNewCommands(client: PoolClient, store: IdempotencyStore, known: Set<string>): Promise<void> {
  for (const [storeKey, entry] of store) {
    if (known.has(storeKey)) continue;
    const [tenantId, operation, key] = JSON.parse(storeKey) as [string, string, string];
    await client.query(
      "insert into public.ordering_commands (tenant_id, operation, command_key, payload_hash, result) values ($1, $2, $3, $4, $5::jsonb)",
      [tenantId, operation, key, entry.payloadHash, JSON.stringify(entry.result)],
    );
  }
}

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

export function toOrder(row: OrderRow, lines: LineRow[]): Order {
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

/** 주문과 품목을 적재한다. `lock`이 있으면 행을 잠근다(update: 변경 예정, share: 변경만 막음). */
export async function loadOrders(
  client: PoolClient,
  tenantId: string,
  options: { orderId?: string; lock?: "update" | "share" },
): Promise<Order[]> {
  if (!isUuid(tenantId) || (options.orderId !== undefined && !isUuid(options.orderId))) return [];
  const orders = (
    await client.query<OrderRow>(
      `select * from public.ordering_orders where tenant_id = $1 ${options.orderId === undefined ? "" : "and id = $2"} ${
        options.lock === "update" ? "for update" : options.lock === "share" ? "for share" : ""
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
