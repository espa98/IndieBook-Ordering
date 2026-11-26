import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStaffApi } from "../../src/db/pgStaffApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
import { createPgSupplierApi } from "../../src/db/pgSupplierApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

/** S-03 권한 위임: Owner가 직원에게 공급처·템플릿 관리(MANAGEMENT)와 재고 조정(STOCK_ADJUSTMENT)을 주고 거둔다. 실제 효과까지 확인한다 */
const T = "aaaaaaaa-0000-4000-8000-0000000000d1";
const OWNER = "11111111-0000-4000-8000-0000000000d1";
const STAFF = "11111111-0000-4000-8000-0000000000d2";
const STAFF_2 = "11111111-0000-4000-8000-0000000000d3";
const EX_STAFF = "11111111-0000-4000-8000-0000000000d4";
const STRANGER = "99999999-0000-4000-8000-0000000000d1";
const BOOK = "b0000000-0000-4000-8000-0000000000d1";
const T0 = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
let seq = 0;
const key = () => `dg-${++seq}`;
const staffApi = () => createPgStaffApi({ pool: db.pool() });
const owner = { userId: OWNER };
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const set = (actor: { userId: string }, targetUserId: string, kind: string, delegated: boolean, extra: Record<string, unknown> = {}) =>
  staffApi().setDelegation(actor, { tenantId: T, targetUserId, kind, delegated, idempotencyKey: key(), ...extra } as never);
const registerSupplier = (actor: { userId: string }, code: string) =>
  createPgSupplierApi({ pool: db.pool() }).registerSupplier(actor, { tenantId: T, code, name: `공급처 ${code}`, orderChannel: "EMAIL", registeredAt: T0, idempotencyKey: key() } as never);
const adjustStock = (actor: { userId: string }) =>
  createPgStockApi({ pool: db.pool() }).adjustStock(actor, { tenantId: T, bookId: BOOK, direction: "IN", quantity: 1, reason: "실사 정정", actedAt: T0, idempotencyKey: key() } as never);

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', true), ($1, $5, 'STAFF', false)`, [T, OWNER, STAFF, STAFF_2, EX_STAFF]);
  await q(`insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '책', 10000, 'MANUAL', '시험', 'seed', now())`, [BOOK, T]);
  await q(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', 5, '초기 재고', 'seed', now())`, [T, BOOK]);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("위임 부여·회수 (S-03, Postgres)", () => {
  it("공급처 관리 위임: 부여 전 직원은 공급처를 등록할 수 없고, 부여하면 할 수 있으며, 회수하면 다시 막힌다(담당자는 인증된 사용자)", async () => {
    expect(await codeOf(() => registerSupplier({ userId: STAFF }, "alpha"))).toBe("FORBIDDEN");

    const granted = await set(owner, STAFF, "MANAGEMENT", true, { changedBy: "위조" });
    expect(granted).toMatchObject({ userId: STAFF, kind: "MANAGEMENT", delegated: true, changedBy: OWNER });
    expect((await q("select delegated_by from public.ordering_management_delegations where tenant_id = $1 and user_id = $2", [T, STAFF]))[0]).toEqual({ delegated_by: OWNER });
    expect(await codeOf(() => registerSupplier({ userId: STAFF }, "alpha"))).toBe("OK");
    expect(await codeOf(() => registerSupplier({ userId: STAFF_2 }, "beta"))).toBe("FORBIDDEN"); // 다른 직원은 그대로

    await set(owner, STAFF, "MANAGEMENT", false);
    expect(await q("select 1 from public.ordering_management_delegations where tenant_id = $1 and user_id = $2", [T, STAFF])).toEqual([]);
    expect(await codeOf(() => registerSupplier({ userId: STAFF }, "gamma"))).toBe("FORBIDDEN");
  });

  it("재고 조정 위임도 같다(종류별로 독립: 공급처 관리 위임은 재고 조정을 열지 않는다)", async () => {
    expect(await codeOf(() => adjustStock({ userId: STAFF_2 }))).toBe("FORBIDDEN");
    await set(owner, STAFF_2, "STOCK_ADJUSTMENT", true);
    expect(await codeOf(() => adjustStock({ userId: STAFF_2 }))).toBe("OK");
    expect(await codeOf(() => registerSupplier({ userId: STAFF_2 }, "delta"))).toBe("FORBIDDEN"); // 관리 위임은 없다
    await set(owner, STAFF_2, "STOCK_ADJUSTMENT", false);
    expect(await codeOf(() => adjustStock({ userId: STAFF_2 }))).toBe("FORBIDDEN");
  });

  it("변경 이력이 추가 전용으로 남고, 위임 목록은 현재 위임만 보여 준다(Owner만)", async () => {
    await set(owner, STAFF, "STOCK_ADJUSTMENT", true);
    await set(owner, STAFF, "MANAGEMENT", true);
    const list = await staffApi().listDelegations(owner, { tenantId: T });
    expect(list.map((d) => [d.userId, d.kind]).sort()).toEqual([[STAFF, "MANAGEMENT"], [STAFF, "STOCK_ADJUSTMENT"]]);
    expect(list[0]).toMatchObject({ delegatedBy: OWNER, delegatedAt: expect.any(String) });

    const history = await q("select user_id, kind, delegated, changed_by from public.ordering_delegation_changes where tenant_id = $1 order by recorded_at, id", [T]);
    expect(history.length).toBeGreaterThanOrEqual(6); // 부여·회수가 모두 남는다
    expect(history.filter((h) => h.delegated === false).length).toBeGreaterThanOrEqual(2);
    const c = await db.connect();
    try {
      expect(await sqlState(() => c.query("update public.ordering_delegation_changes set delegated = true"))).toBe("P0001");
      expect(await sqlState(() => c.query("delete from public.ordering_delegation_changes"))).toBe("P0001");
    } finally {
      await c.end();
    }
  });

  it("Staff·비멤버·비활성은 FORBIDDEN, 대상이 멤버가 아니면 NOT_FOUND, Owner·비활성 직원에게 부여는 422, 이미 그 상태면 422이고 멱등 키 재시도는 한 번만 반영한다", async () => {
    expect(await codeOf(() => set({ userId: STAFF }, STAFF_2, "MANAGEMENT", true))).toBe("FORBIDDEN");
    expect(await codeOf(() => set({ userId: STRANGER }, STAFF_2, "MANAGEMENT", true))).toBe("FORBIDDEN");
    expect(await codeOf(() => set({ userId: EX_STAFF }, STAFF_2, "MANAGEMENT", true))).toBe("FORBIDDEN");
    expect(await codeOf(() => set(owner, STRANGER, "MANAGEMENT", true))).toBe("NOT_FOUND");
    expect(await codeOf(() => set(owner, OWNER, "MANAGEMENT", true))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => set(owner, EX_STAFF, "MANAGEMENT", true))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => set(owner, STAFF, "MANAGEMENT", true))).toBe("BUSINESS_INVARIANT"); // 이미 부여됨
    expect(await codeOf(() => set(owner, STAFF, "ALL", true))).toBe("VALIDATION_ERROR");

    const before = (await q("select count(*)::int as n from public.ordering_delegation_changes"))[0].n as number;
    const k = key();
    await set(owner, STAFF_2, "MANAGEMENT", true, { idempotencyKey: k });
    await set(owner, STAFF_2, "MANAGEMENT", true, { idempotencyKey: k });
    expect((await q("select count(*)::int as n from public.ordering_delegation_changes"))[0].n).toBe(before + 1);
    for (const userId of [STAFF, STRANGER, EX_STAFF]) expect(await codeOf(() => staffApi().listDelegations({ userId }, { tenantId: T })), userId).toBe("FORBIDDEN");
  });

  it("동시에 같은 위임을 부여하면 하나만 성공한다", async () => {
    const results = await Promise.all([
      set(owner, STAFF_2, "STOCK_ADJUSTMENT", true).then(() => "OK", (e) => (e as AppError).code),
      set(owner, STAFF_2, "STOCK_ADJUSTMENT", true).then(() => "OK", (e) => (e as AppError).code),
    ]);
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "BUSINESS_INVARIANT")).toHaveLength(1);
  });
});
