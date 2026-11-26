import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAccountApi } from "../../src/db/pgAccountApi";
import { createPgStoreApi } from "../../src/db/pgStoreApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

/** S-01 서점 기본정보·S-07 미수령 경고일: 조회(활성 멤버)와 변경(Owner만, 변경 이력 추가 전용) */
const OWNER = "11111111-0000-4000-8000-0000000000e5";
const STAFF = "11111111-0000-4000-8000-0000000000e6";
const EX_STAFF = "11111111-0000-4000-8000-0000000000e7";
const STRANGER = "99999999-0000-4000-8000-0000000000e5";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000e8";

let db: IsolatedPostgres;
let T = "";
let T2 = "";
let T_OTHER = "";
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
const api = () => createPgStoreApi({ pool: db.pool() });
const owner = { userId: OWNER };
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const update = (actor: { userId: string }, tenantId: string, body: Record<string, unknown>) => api().updateStoreSettings(actor, { tenantId, idempotencyKey: key(), ...body } as never);

beforeAll(async () => {
  db = await startMigratedPostgres();
  const accounts = createPgAccountApi({ pool: db.pool() });
  T = (await accounts.openStore({ userId: OWNER, email: "o@shop.test" }, { storeName: "책방 오후 세시", idempotencyKey: key() })).tenant.id;
  T2 = (await accounts.openStore({ userId: OWNER, email: "o@shop.test" }, { storeName: "두번째 서점", idempotencyKey: key() })).tenant.id;
  T_OTHER = (await accounts.openStore({ userId: OTHER_OWNER, email: "p@shop.test" }, { storeName: "남의 서점", idempotencyKey: key() })).tenant.id;
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'STAFF', true), ($1, $3, 'STAFF', false)`, [T, STAFF, EX_STAFF]);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("서점 기본정보 조회 (S-01)", () => {
  it("활성 멤버는 서점 정보(이름·상태·개설일·경고일 기본 7일)와 자기 역할을 읽고, 비멤버·비활성·다른 서점은 FORBIDDEN이다", async () => {
    const info = await api().getStore({ userId: STAFF }, { tenantId: T });
    expect(info).toEqual({ id: T, name: "책방 오후 세시", status: "ACTIVE", createdAt: expect.any(String), longUnreceivedWarningDays: 7, myRole: "STAFF" });
    expect((await api().getStore(owner, { tenantId: T })).myRole).toBe("OWNER");
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => api().getStore({ userId }, { tenantId: T })), userId).toBe("FORBIDDEN");
  });
});

describe("서점 설정 변경 (S-01·S-07, Owner만)", () => {
  it("이름과 경고일이 저장되고 바뀐 항목의 전·후 값이 이력에 남는다(담당자는 인증된 사용자)", async () => {
    const change = await update(owner, T, { name: "  책방, 오후 네시 ", longUnreceivedWarningDays: 14, changedBy: "위조" });
    expect(change).toMatchObject({ tenantId: T, changedBy: OWNER, changes: { name: { from: "책방 오후 세시", to: "책방, 오후 네시" }, longUnreceivedWarningDays: { from: 7, to: 14 } } });
    expect((await q("select name, long_unreceived_warning_days as days from public.ordering_tenants where id = $1", [T]))[0]).toEqual({ name: "책방, 오후 네시", days: 14 });
    expect(await api().getStore(owner, { tenantId: T })).toMatchObject({ name: "책방, 오후 네시", longUnreceivedWarningDays: 14 });
    const history = await q("select changes, changed_by from public.ordering_tenant_setting_changes where tenant_id = $1", [T]);
    expect(history).toEqual([{ changes: change.changes, changed_by: OWNER }]);
  });

  it("Staff·비멤버는 FORBIDDEN, 같은 값·같은 소유자의 다른 서점 이름은 422, 범위 밖 경고일은 400, 다른 소유자의 서점 이름과는 겹쳐도 된다", async () => {
    expect(await codeOf(() => update({ userId: STAFF }, T, { name: "직원이 바꿈" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => update({ userId: STRANGER }, T, { name: "외부인" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => update({ userId: EX_STAFF }, T, { name: "비활성" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => update(owner, T, { name: "책방, 오후 네시" }))).toBe("BUSINESS_INVARIANT"); // 같은 값
    expect(await codeOf(() => update(owner, T, { name: "두번째 서점" }))).toBe("BUSINESS_INVARIANT"); // 같은 소유자의 다른 서점
    expect(await codeOf(() => update(owner, T, { longUnreceivedWarningDays: 0 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => update(owner, T, { longUnreceivedWarningDays: 366 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => update(owner, T, {}))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => update(owner, T_OTHER, { name: "남이 바꿈" }))).toBe("FORBIDDEN"); // 다른 서점의 Owner는 이 서점이 아니다
    expect(await codeOf(() => update({ userId: OTHER_OWNER }, T, { name: "남의 서점" }))).toBe("FORBIDDEN"); // 다른 서점 Owner는 이 서점 멤버가 아니다
    expect((await q("select name from public.ordering_tenants where id = $1", [T]))[0].name).toBe("책방, 오후 네시"); // 거부된 시도는 아무것도 바꾸지 않는다
    expect(await codeOf(() => update(owner, T2, { name: "남의 서점" }))).toBe("OK"); // 다른 소유자의 서점 이름과는 겹쳐도 된다
  });

  it("멱등 키 재시도는 한 번만 반영하고, 이력은 추가 전용이며, 동시에 같은 이름으로 바꾸면 하나만 성공한다", async () => {
    const k = key();
    const first = await update(owner, T, { longUnreceivedWarningDays: 21, idempotencyKey: k });
    expect(await update(owner, T, { longUnreceivedWarningDays: 21, idempotencyKey: k })).toEqual(first);
    expect((await q("select count(*)::int as n from public.ordering_tenant_setting_changes where tenant_id = $1", [T]))[0].n).toBe(2);
    const c = await db.connect();
    try {
      expect(await sqlState(() => c.query("update public.ordering_tenant_setting_changes set changed_by = 'x'"))).toBe("P0001");
      expect(await sqlState(() => c.query("delete from public.ordering_tenant_setting_changes"))).toBe("P0001");
      expect(await sqlState(() => c.query("update public.ordering_tenants set long_unreceived_warning_days = 0 where id = $1", [T]))).toBe("23514");
    } finally {
      await c.end();
    }

    // 한 소유자의 두 서점이 동시에 같은 새 이름을 가지려 하면(경쟁) 하나만 성공한다
    const results = await Promise.all([
      update(owner, T, { name: "동시 이름" }).then(() => "OK", (e) => (e as AppError).code),
      update(owner, T2, { name: "동시 이름" }).then(() => "OK", (e) => (e as AppError).code),
    ]);
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "BUSINESS_INVARIANT")).toHaveLength(1);
  });
});
