import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

/** 초안 보류·재개·폐기 이력: 재개하거나 폐기해도 사유가 남는다(추가 전용 원장). 읽기는 `getOrderHistory` */
const T = "aaaaaaaa-0000-4000-8000-00000000000e";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000f";
const OWNER = "11111111-0000-4000-8000-00000000000e";
const STAFF = "11111111-0000-4000-8000-00000000001e";
const OTHER_OWNER = "11111111-0000-4000-8000-00000000000f";
const STRANGER = "99999999-0000-4000-8000-00000000000e";
const T1 = "2026-03-04T06:00:00.000Z";
const T2 = "2026-03-04T06:10:00.000Z";
const T3 = "2026-03-04T06:20:00.000Z";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  for (const [t, o] of [[T, OWNER], [OTHER, OTHER_OWNER]]) {
    await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [t, o]);
    await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [t, o]);
  }
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'STAFF', true)`, [T, STAFF]);
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
const key = () => `hist-${++seq}`;
const orders = () => createPgOrderApi({ pool: db.pool() });
const reads = () => createPgReadApi({ pool: db.pool() });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const draft = async (tenantId = T, userId = OWNER) => (await orders().createOrder({ userId }, { tenantId, idempotencyKey: key(), lines: [] })) as { id: string };

describe("주문 보류·재개·폐기 이력", () => {
  it("보류→재개→보류→폐기가 시간순으로 남고, 재개·폐기 뒤에도 보류 사유가 보인다(담당자는 인증된 사용자)", async () => {
    const order = await draft();
    const held = await orders().holdOrder({ userId: STAFF }, { tenantId: T, orderId: order.id, expectedVersion: 1, reason: "입금 확인 중", heldAt: T1, idempotencyKey: key() } as never);
    const resumed = await orders().resumeOrder({ userId: OWNER }, { tenantId: T, orderId: order.id, expectedVersion: held.version, resumedAt: T2, idempotencyKey: key() } as never);
    const held2 = await orders().holdOrder({ userId: OWNER }, { tenantId: T, orderId: order.id, expectedVersion: resumed.version, reason: "재고 확인", heldAt: T3, idempotencyKey: key() } as never);
    await orders().discardOrder({ userId: OWNER }, { tenantId: T, orderId: order.id, expectedVersion: held2.version, reason: "고객 철회", discardedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() } as never);

    const history = await reads().getOrderHistory({ userId: STAFF }, { tenantId: T, orderId: order.id });
    expect(history.map((e) => [e.kind, e.reason ?? null, e.by, e.at])).toEqual([
      ["HOLD", "입금 확인 중", STAFF, T1],
      ["RESUME", null, OWNER, T2],
      ["HOLD", "재고 확인", OWNER, T3],
      ["DISCARD", "고객 철회", OWNER, "2026-03-04T06:30:00.000Z"],
    ]);
  });

  it("같은 멱등 키의 재시도는 이력을 늘리지 않고, 거부된 시도는 이력을 남기지 않는다", async () => {
    const order = await draft();
    const k = key();
    const request = { tenantId: T, orderId: order.id, expectedVersion: 1, reason: "확인", heldAt: T1, idempotencyKey: k } as never;
    await orders().holdOrder({ userId: OWNER }, request);
    await orders().holdOrder({ userId: OWNER }, request);
    expect(await codeOf(() => orders().holdOrder({ userId: OWNER }, { tenantId: T, orderId: order.id, expectedVersion: 2, reason: "또", heldAt: T1, idempotencyKey: key() } as never))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => orders().discardOrder({ userId: STRANGER }, { tenantId: T, orderId: order.id, expectedVersion: 2, reason: "x", discardedAt: T1, idempotencyKey: key() } as never))).toBe("FORBIDDEN");
    expect((await reads().getOrderHistory({ userId: OWNER }, { tenantId: T, orderId: order.id })).map((e) => e.kind)).toEqual(["HOLD"]);
  });

  it("조회 권한: 비멤버는 FORBIDDEN, 다른 서점의 주문·없는 주문은 같은 NOT_FOUND, 이력이 없는 주문은 빈 목록", async () => {
    const mine = await draft();
    const theirs = await draft(OTHER, OTHER_OWNER);
    expect(await reads().getOrderHistory({ userId: OWNER }, { tenantId: T, orderId: mine.id })).toEqual([]);
    expect(await codeOf(() => reads().getOrderHistory({ userId: STRANGER }, { tenantId: T, orderId: mine.id }))).toBe("FORBIDDEN");
    expect(await codeOf(() => reads().getOrderHistory({ userId: OWNER }, { tenantId: T, orderId: theirs.id }))).toBe("NOT_FOUND");
    expect(await codeOf(() => reads().getOrderHistory({ userId: OWNER }, { tenantId: T, orderId: "aaaaaaaa-0000-4000-8000-0000000000ff" }))).toBe("NOT_FOUND");
  });

  it("DB: 이력은 추가 전용이고 사유 없는 보류·폐기는 거부한다", async () => {
    const order = await draft();
    await orders().holdOrder({ userId: OWNER }, { tenantId: T, orderId: order.id, expectedVersion: 1, reason: "확인", heldAt: T1, idempotencyKey: key() } as never);
    const c = await db.connect();
    try {
      const run = (sql: string, params: unknown[] = []) => sqlState(() => c.query(sql, params));
      expect(await run("update public.ordering_order_events set reason = 'x' where order_id = $1", [order.id])).toBe("P0001");
      expect(await run("delete from public.ordering_order_events where order_id = $1", [order.id])).toBe("P0001");
      expect(await run("insert into public.ordering_order_events (tenant_id, order_id, kind, actor_id, occurred_at) values ($1, $2, 'HOLD', 'u', now())", [T, order.id])).toBe("23514");
      expect(await run("insert into public.ordering_order_events (tenant_id, order_id, kind, actor_id, occurred_at) values ($1, $2, 'BOGUS', 'u', now())", [T, order.id])).toBe("23514");
    } finally {
      await c.end();
    }
  });
});
