import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgProcurementApi } from "../../src/db/pgProcurementApi";
import { createPgSupplierApi } from "../../src/db/pgSupplierApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002"; // 위임 없음
const DELEGATE_A = "11111111-0000-4000-8000-000000000004"; // 위임된 직원
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', true), ($5, $6, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, DELEGATE_A, T_B, OWNER_B],
  );
  await c.query(`insert into public.ordering_management_delegations (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, now())`, [T_A, DELEGATE_A, OWNER_A]);
  await c.query(`insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '책', 10000, 'MANUAL', '시험', 'seed', now())`, [BOOK(1), T_A]);
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const staff = { userId: STAFF_A };
const delegate = { userId: DELEGATE_A };
let seq = 0;
const key = () => `s-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
type Api = ReturnType<typeof createPgSupplierApi>;
const register = (api: Api, code: string, actor = owner, tenantId = T_A) =>
  api.registerSupplier(actor, { tenantId, code, name: `공급처 ${code}`, orderChannel: "EMAIL", registeredAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
const update = (api: Api, code: string, expectedVersion: number, changes: { name?: string; orderChannel?: "WEB" | "EMAIL" }, actor = owner) =>
  api.updateSupplier(actor, { tenantId: T_A, code, expectedVersion, changes, reason: "연락처 변경", changedAt: "2026-03-04T06:10:00.000Z", idempotencyKey: key() });
const setActive = (api: Api, code: string, active: boolean, actor = owner) =>
  api.setSupplierActive(actor, { tenantId: T_A, code, active, reason: "거래 중단", changedAt: "2026-03-04T06:20:00.000Z", idempotencyKey: key() });

describe("공급처 등록·수정·활성 전환 (Postgres 영속화)", () => {
  it("Owner와 위임된 직원이 공급처를 등록하고 변경 이력을 남기며, 중복 코드·형식 오류·위임 없는 직원·비멤버는 거부된다", async () => {
    const api = createPgSupplierApi({ pool: db.pool() });

    expect(await register(api, "alpha")).toMatchObject({ code: "alpha", active: true, version: 1, name: "공급처 alpha", orderChannel: "EMAIL" });
    expect((await rows("select active, version::int as version, order_channel from public.ordering_suppliers where tenant_id = $1 and code = 'alpha'", [T_A]))[0]).toEqual({ active: true, version: 1, order_channel: "EMAIL" });
    expect(await rows("select kind, \"by\" from public.ordering_supplier_changes where tenant_id = $1 and code = 'alpha'", [T_A])).toEqual([{ kind: "REGISTERED", by: OWNER_A }]);

    expect(await codeOf(() => register(api, "alpha"))).toBe("BUSINESS_INVARIANT"); // 이미 있는 코드
    expect(await codeOf(() => register(api, "Bad Code"))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => register(api, "beta", staff))).toBe("FORBIDDEN"); // 위임되지 않은 직원
    expect((await register(api, "beta", delegate)).code).toBe("beta"); // 위임된 직원
    expect(await codeOf(() => register(api, "gamma", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect((await register(api, "alpha", { userId: OWNER_B }, T_B)).code).toBe("alpha"); // 다른 서점은 같은 코드를 쓸 수 있다
  });

  it("수정은 version을 올리고 이전 값을 이력에 남기며, 비활성화는 진행 중 발주를 이력에 남기고 신규 발주를 막으며, 복구하면 다시 쓸 수 있다", async () => {
    const api = createPgSupplierApi({ pool: db.pool() });
    await register(api, "delta");

    expect(await codeOf(() => update(api, "delta", 9, { name: "새 이름" }))).toBe("VERSION_CONFLICT");
    expect(await codeOf(() => update(api, "none", 1, { name: "새 이름" }))).toBe("NOT_FOUND");
    expect(await update(api, "delta", 1, { name: "새 이름", orderChannel: "WEB" })).toMatchObject({ version: 2, name: "새 이름", orderChannel: "WEB" });
    const change = (await rows("select kind, before, after, reason from public.ordering_supplier_changes where tenant_id = $1 and code = 'delta' and kind = 'UPDATED'", [T_A]))[0];
    expect(change).toMatchObject({ reason: "연락처 변경", before: { name: "공급처 delta", orderChannel: "EMAIL", active: true }, after: { name: "새 이름", orderChannel: "WEB", active: true } });

    // 진행 중 발주가 있는 공급처를 비활성화한다
    const orders = createPgOrderApi({ pool: db.pool() });
    const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(1), quantity: 2, unitPriceKrw: "15000" }] });
    const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
    const procurement = createPgProcurementApi({ pool: db.pool() });
    const allocation = await procurement.allocateSourcing(owner, { tenantId: T_A, orderId: order.id, lineId: order.lines[0]!.lineId, supplierCode: "delta", quantity: 2, idempotencyKey: key() });
    const po = await procurement.createPurchaseOrder(owner, { tenantId: T_A, supplierCode: "delta", allocationIds: [allocation.id], idempotencyKey: key() });

    expect(await setActive(api, "delta", false)).toMatchObject({ active: false, version: 3 });
    expect(await rows("select kind, open_purchase_order_ids from public.ordering_supplier_changes where tenant_id = $1 and code = 'delta' and kind = 'DEACTIVATED'", [T_A])).toEqual([{ kind: "DEACTIVATED", open_purchase_order_ids: [po.id] }]);
    expect(await codeOf(() => setActive(api, "delta", false))).toBe("BUSINESS_INVARIANT"); // 이미 비활성
    const other = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(1), quantity: 1, unitPriceKrw: "15000" }] });
    const otherOrder = await orders.confirmOrder(owner, { tenantId: T_A, orderId: other.id, expectedVersion: 1, idempotencyKey: key() });
    expect(await codeOf(() => procurement.allocateSourcing(owner, { tenantId: T_A, orderId: otherOrder.id, lineId: otherOrder.lines[0]!.lineId, supplierCode: "delta", quantity: 1, idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT"); // 신규 배정 차단
    expect(await codeOf(() => setActive(api, "delta", true, staff))).toBe("FORBIDDEN");
    expect(await setActive(api, "delta", true)).toMatchObject({ active: true, version: 4 });
    expect((await procurement.allocateSourcing(owner, { tenantId: T_A, orderId: otherOrder.id, lineId: otherOrder.lines[0]!.lineId, supplierCode: "delta", quantity: 1, idempotencyKey: key() })).status).toBe("ACTIVE");
  });
});

const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();

describe("공급처의 실제 동시성과 DB 방어 (두 독립 세션)", () => {
  it("같은 코드를 동시에 등록하면 하나만 성공하고, 같은 version의 동시 수정도 하나만 성공한다", async () => {
    const registered = await Promise.allSettled([register(createPgSupplierApi({ pool: db.pool() }), "epsilon"), register(createPgSupplierApi({ pool: db.pool() }), "epsilon")]);
    expect(outcomes(registered)).toEqual(["BUSINESS_INVARIANT", "OK"]);

    const updated = await Promise.allSettled([
      update(createPgSupplierApi({ pool: db.pool() }), "epsilon", 1, { name: "이름 1" }),
      update(createPgSupplierApi({ pool: db.pool() }), "epsilon", 1, { name: "이름 2" }),
    ]);
    expect(outcomes(updated)).toEqual(["OK", "VERSION_CONFLICT"]);
    expect((await rows("select version::int as version from public.ordering_suppliers where tenant_id = $1 and code = 'epsilon'", [T_A]))[0].version).toBe(2);
  });

  it("직접 SQL로도 공급처 version을 건너뛰거나 코드를 바꾸거나 변경 이력을 고칠 수 없다", async () => {
    await register(createPgSupplierApi({ pool: db.pool() }), "zeta");
    const c = await db.connect();
    const q = (sql: string) => () => c.query(sql);
    try {
      expect(await sqlState(q(`update public.ordering_suppliers set name = 'x', version = 3 where tenant_id = '${T_A}' and code = 'zeta'`))).toBe("P0001");
      expect(await sqlState(q(`update public.ordering_suppliers set code = 'zeta2', version = 2 where tenant_id = '${T_A}' and code = 'zeta'`))).toBe("P0001");
      expect(await sqlState(q(`update public.ordering_supplier_changes set reason = 'x' where tenant_id = '${T_A}' and code = 'zeta'`))).toBe("P0001"); // 추가 전용
      await c.query(`update public.ordering_suppliers set name = 'ok', version = 2 where tenant_id = '${T_A}' and code = 'zeta'`);
    } finally {
      await c.end();
    }
  });
});

void sqlState;
