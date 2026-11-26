import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAccountApi } from "../../src/db/pgAccountApi";
import { createPgCustomerApi } from "../../src/db/pgCustomerApi";
import { createPgStoreApi } from "../../src/db/pgStoreApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** 서점 중지·해지(ST-A06/A07)와 운영자 승인 재사용: 중지된 서점은 전부 막히고, 운영자 승인으로만 돌아온다 */
const OWNER = "11111111-0000-4000-8000-0000000000a1";
const STAFF = "11111111-0000-4000-8000-0000000000a2";
const ADMIN = "11111111-0000-4000-8000-0000000000a9";
const STRANGER = "99999999-0000-4000-8000-0000000000a1";
const AT = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
let T = "";
let T2 = "";
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
let seq = 0;
const key = () => `ss-${++seq}`;
const store = () => createPgStoreApi({ pool: db.pool() });
const customers = () => createPgCustomerApi({ pool: db.pool() });
const owner = { userId: OWNER };
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const deactivate = (actor: { userId: string }, tenantId: string, extra: Record<string, unknown> = {}) =>
  store().deactivateStore(actor, { tenantId, kind: "SUSPENDED", reason: "일시 중단", changedAt: AT, idempotencyKey: key(), ...extra } as never);
const reactivate = (storeId: string, extra: Record<string, unknown> = {}) =>
  store().reactivateStore({ userId: ADMIN }, { storeId, reason: "운영자 확인 완료", approvedAt: AT, idempotencyKey: key(), ...extra } as never);

beforeAll(async () => {
  db = await startMigratedPostgres();
  const accounts = createPgAccountApi({ pool: db.pool() });
  T = (await accounts.openStore({ userId: OWNER, email: "o@shop.test" }, { storeName: "중지될 서점", idempotencyKey: key() })).tenant.id;
  T2 = (await accounts.openStore({ userId: OWNER, email: "o@shop.test" }, { storeName: "계속 쓰는 서점", idempotencyKey: key() })).tenant.id;
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'STAFF', true)`, [T, STAFF]);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("서점 중지 (ST-A06, Postgres)", () => {
  it("Owner만 중지할 수 있고(직원·남은 FORBIDDEN), 중지되면 그 서점의 모든 서점 범위 요청이 FORBIDDEN이며 같은 Owner의 다른 서점은 그대로 쓰고 이력에 남는다", async () => {
    expect(await codeOf(() => deactivate({ userId: STAFF }, T))).toBe("FORBIDDEN");
    expect(await codeOf(() => deactivate({ userId: STRANGER }, T))).toBe("FORBIDDEN");
    expect((await q(`select status from public.ordering_tenants where id = $1`, [T]))[0]).toEqual({ status: "ACTIVE" });

    const change = await deactivate(owner, T, { reason: "폐업 준비" });

    expect(change).toMatchObject({ tenantId: T, kind: "DEACTIVATED", from: "ACTIVE", to: "SUSPENDED", reason: "폐업 준비", by: OWNER, at: AT });
    expect((await q(`select status from public.ordering_tenants where id = $1`, [T]))[0]).toEqual({ status: "SUSPENDED" });
    expect((await q(`select kind, from_status, to_status, reason, "by" from public.ordering_tenant_status_changes where tenant_id = $1`, [T]))).toEqual([{ kind: "DEACTIVATED", from_status: "ACTIVE", to_status: "SUSPENDED", reason: "폐업 준비", by: OWNER }]);
    for (const actor of [owner, { userId: STAFF }]) {
      expect(await codeOf(() => store().getStore(actor, { tenantId: T }))).toBe("FORBIDDEN");
      expect(await codeOf(() => customers().listCustomers(actor, { tenantId: T } as never))).toBe("FORBIDDEN");
    }
    expect(await codeOf(() => store().getStore(owner, { tenantId: T2 }))).toBe("OK");
    expect(await codeOf(() => deactivate(owner, T))).toBe("FORBIDDEN"); // 이미 중지된 서점은 Owner도 요청할 수 없다
  });
});

describe("운영자 승인 재사용 (Postgres)", () => {
  it("운영자 목록에 중지·해지된 서점과 사유가 보이고, 승인하면 다시 쓸 수 있으며 승인 이력이 남는다(같은 키는 한 번만, 이미 사용 중이거나 없는 서점은 거부)", async () => {
    await deactivate(owner, T2, { kind: "TERMINATED", reason: "폐업" }); // T는 앞 시험에서 중지됨

    const listed = await store().listInactiveStores({ userId: ADMIN });
    expect(listed.items.map((i) => [i.storeId, i.status, i.reason]).sort()).toEqual([[T, "SUSPENDED", "폐업 준비"], [T2, "TERMINATED", "폐업"]].sort());
    expect(listed.items[0]).toMatchObject({ name: expect.any(String), ownerUserId: OWNER, deactivatedBy: OWNER });

    const change = await reactivate(T, { idempotencyKey: "approve-1" });
    expect(change).toMatchObject({ tenantId: T, kind: "REACTIVATED", from: "SUSPENDED", to: "ACTIVE", by: ADMIN, reason: "운영자 확인 완료" });
    expect(await reactivate(T, { idempotencyKey: "approve-1" })).toEqual(change);
    expect(await codeOf(() => store().getStore(owner, { tenantId: T }))).toBe("OK");
    expect(await codeOf(() => customers().listCustomers({ userId: STAFF }, { tenantId: T } as never))).toBe("OK");
    expect((await q(`select kind, "by" from public.ordering_tenant_status_changes where tenant_id = $1 order by recorded_at, id`, [T]))).toEqual([{ kind: "DEACTIVATED", by: OWNER }, { kind: "REACTIVATED", by: ADMIN }]);

    expect(await codeOf(() => reactivate(T))).toBe("BUSINESS_INVARIANT"); // 이미 사용 중
    expect(await codeOf(() => reactivate("00000000-0000-4000-8000-000000000000"))).toBe("NOT_FOUND");
    expect(await codeOf(() => reactivate("not-a-uuid"))).toBe("NOT_FOUND");
    expect((await store().listInactiveStores({ userId: ADMIN })).items.map((i) => i.storeId)).toEqual([T2]);
    expect(await codeOf(() => reactivate(T2, { reason: " " }))).toBe("VALIDATION_ERROR");
  });
});
