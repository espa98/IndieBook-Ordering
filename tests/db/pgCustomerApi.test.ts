import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCustomerApi } from "../../src/db/pgCustomerApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const T = "aaaaaaaa-0000-4000-8000-0000000000f1";
const T2 = "aaaaaaaa-0000-4000-8000-0000000000f2";
const OWNER = "11111111-0000-4000-8000-0000000000f1";
const STAFF = "11111111-0000-4000-8000-0000000000f2";
const STRANGER = "99999999-0000-4000-8000-0000000000f1";
const AT = "2026-03-04T06:00:00.000Z";

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
const key = () => `cus-${++seq}`;
const api = () => createPgCustomerApi({ pool: db.pool() });
const owner = { userId: OWNER };
const staff = { userId: STAFF };
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const register = (actor: { userId: string }, extra: Record<string, unknown> = {}, tenantId = T) =>
  api().registerCustomer(actor, { tenantId, name: "김독자", phone: "010-1234-5678", registeredAt: AT, idempotencyKey: key(), ...extra } as never);

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '다른서점', $4)`, [T, OWNER, T2, STRANGER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($4, $5, 'OWNER', true)`, [T, OWNER, STAFF, T2, STRANGER]);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("고객 등록 (C-02, Postgres)", () => {
  it("직원이 등록하면 정규화된 번호로 저장되고 이력이 남으며, 같은 번호의 다음 등록은 중복 후보를 돌려준다(다른 서점은 후보 아님)", async () => {
    const first = await register(staff);
    await register(owner, {}, T); // 같은 서점, 같은 번호
    await register({ userId: STRANGER }, {}, T2);
    const third = await register(owner, { name: "박가족" });

    expect(first.customer).toEqual({ id: expect.any(String), tenantId: T, name: "김독자", phone: "01012345678", version: 1 });
    expect(first.duplicateCandidates).toEqual([]);
    expect(third.duplicateCandidates).toHaveLength(2);
    expect(third.duplicateCandidates.every((d: { sameName: boolean }) => d.sameName === false)).toBe(true);
    expect(await q(`select kind, "by" from public.ordering_customer_changes where customer_id = $1`, [first.customer.id])).toEqual([{ kind: "REGISTERED", by: STAFF }]);
    expect(await codeOf(() => register({ userId: STRANGER }))).toBe("FORBIDDEN");
  });
});

describe("고객 수정 (C-03, Postgres)", () => {
  it("직원이 수정하면 DB에 반영되고 전·후 값 이력이 남으며, 오래된 버전은 VERSION_CONFLICT이고 다른 서점 고객은 NOT_FOUND이다", async () => {
    const { customer } = await register(staff, { name: "수정대상", phone: "010-2222-3333" });
    const body = (extra: Record<string, unknown> = {}) => ({ tenantId: T, customerId: customer.id, expectedVersion: 1, changes: { name: "수정완료" }, changedAt: AT, idempotencyKey: key(), ...extra }) as never;

    const updated = await api().updateCustomer(staff, body());

    expect(updated).toEqual({ ...customer, name: "수정완료", version: 2 });
    expect((await q(`select name, version from public.ordering_customers where id = $1`, [customer.id]))[0]).toEqual({ name: "수정완료", version: 2 });
    expect((await q(`select kind, before, after from public.ordering_customer_changes where customer_id = $1 and kind = 'UPDATED'`, [customer.id]))[0]).toEqual({
      kind: "UPDATED",
      before: { name: "수정대상", phone: "01022223333" },
      after: { name: "수정완료", phone: "01022223333" },
    });
    expect(await codeOf(() => api().updateCustomer(staff, body()))).toBe("VERSION_CONFLICT");
    expect(await codeOf(() => api().updateCustomer({ userId: STRANGER }, body({ tenantId: T2 })))).toBe("NOT_FOUND");
    expect(await codeOf(() => api().updateCustomer({ userId: STRANGER }, body()))).toBe("FORBIDDEN");
  });
});

describe("고객 익명화 (Postgres)", () => {
  it("Owner만 익명화할 수 있고(직원은 FORBIDDEN), DB에서 이름·번호가 비식별화되며 원래 값은 이력에만 남고 번호 중복 후보에서 빠진다", async () => {
    const { customer } = await register(staff, { name: "삭제요청", phone: "010-7777-8888" });
    const body = (extra: Record<string, unknown> = {}) => ({ tenantId: T, customerId: customer.id, expectedVersion: 1, anonymizedAt: AT, idempotencyKey: key(), ...extra }) as never;

    expect(await codeOf(() => api().anonymizeCustomer(staff, body()))).toBe("FORBIDDEN");
    const result = await api().anonymizeCustomer(owner, body());

    expect(result).toEqual({ id: customer.id, tenantId: T, name: "(익명)", phone: null, anonymizedAt: AT, version: 2 });
    expect((await q(`select name, phone, anonymized_at is not null as anonymized from public.ordering_customers where id = $1`, [customer.id]))[0]).toEqual({ name: "(익명)", phone: null, anonymized: true });
    expect((await q(`select before, after from public.ordering_customer_changes where customer_id = $1 and kind = 'ANONYMIZED'`, [customer.id]))[0]).toEqual({ before: { name: "삭제요청", phone: "01077778888" }, after: { name: "(익명)", phone: null } });
    expect((await register(staff, { phone: "01077778888" })).duplicateCandidates).toEqual([]);
    expect(await codeOf(() => api().updateCustomer(owner, { tenantId: T, customerId: customer.id, expectedVersion: 2, changes: { name: "복구" }, changedAt: AT, idempotencyKey: key() } as never))).toBe("BUSINESS_INVARIANT");
  });
});

describe("고객 목록·검색 (C-01, Postgres)", () => {
  it("최신 등록순으로, 번호는 끝 4자리만 보여 주며, 이름 부분 일치와 번호 숫자열(3자리 이상) 부분 일치로 찾는다(다른 서점·익명 고객은 제외하지 않고 익명은 표시)", async () => {
    const A = await register(staff, { name: "검색가나다", phone: "010-5555-1111" });
    const B = await register(staff, { name: "검색라마바", phone: "02-345-6789" });
    const view = (r: any) => r.items.map((i: { name: string }) => i.name);

    const all = await api().listCustomers(staff, { tenantId: T, limit: 2 } as never);
    expect(all.items.map((i: { id: string }) => i.id)).toEqual([B.customer.id, A.customer.id]);
    expect(all.items[0]).toEqual({ id: B.customer.id, name: "검색라마바", phoneLast4: "6789", version: 1, anonymized: false });
    expect(JSON.stringify(all)).not.toContain("0234");
    expect(view(await api().listCustomers(staff, { tenantId: T, search: "가나" } as never))).toEqual(["검색가나다"]);
    expect(view(await api().listCustomers(staff, { tenantId: T, search: "6789" } as never))).toEqual(["검색라마바"]);
    expect(view(await api().listCustomers(staff, { tenantId: T, search: "5555" } as never))).toEqual(["검색가나다"]);
    expect(view(await api().listCustomers(staff, { tenantId: T, search: "12" } as never))).toEqual([]); // 번호 검색은 3자리 이상, 이름에도 없음
    expect((await api().listCustomers(staff, { tenantId: T2 } as never).catch((e) => e.code))).toBe("FORBIDDEN");
    expect(await codeOf(() => api().listCustomers(staff, { tenantId: T, limit: 0 } as never))).toBe("VALIDATION_ERROR");
  });

  it("검색어의 %·_는 와일드카드가 아니라 글자 그대로 찾는다", async () => {
    await register(staff, { name: "백분율100%", phone: "010-6060-1212" });

    const names = async (search: string) => (await api().listCustomers(staff, { tenantId: T, search } as never)).items.map((i: { name: string }) => i.name);
    expect(await names("%")).toEqual(["백분율100%"]);
    expect(await names("_")).toEqual([]);
    expect(await names("검%다")).toEqual([]);
  });
});

describe("고객 상세·변경 이력 (C-03, C-04, Postgres)", () => {
  it("상세는 번호 전체를 보여 주고(다른 서점·없는 고객은 NOT_FOUND), 이력은 Owner에게 전·후 값을, 직원에게는 종류·행위자·시각만 보여 준다", async () => {
    const { customer } = await register(staff, { name: "이력대상", phone: "010-4444-5555" });
    await api().updateCustomer(owner, { tenantId: T, customerId: customer.id, expectedVersion: 1, changes: { name: "이력변경" }, changedAt: AT, idempotencyKey: key() } as never);

    expect(await api().getCustomer(staff, { tenantId: T, customerId: customer.id })).toEqual({ id: customer.id, tenantId: T, name: "이력변경", phone: "01044445555", version: 2 });
    expect(await codeOf(() => api().getCustomer({ userId: STRANGER }, { tenantId: T2, customerId: customer.id }))).toBe("NOT_FOUND");
    expect(await codeOf(() => api().getCustomer(staff, { tenantId: T, customerId: "not-a-uuid" }))).toBe("NOT_FOUND");

    const asOwner = await api().listCustomerChanges(owner, { tenantId: T, customerId: customer.id });
    expect(asOwner.items.map((c: { kind: string }) => c.kind)).toEqual(["REGISTERED", "UPDATED"]);
    expect(asOwner.items[1]).toEqual({ id: expect.any(String), kind: "UPDATED", before: { name: "이력대상", phone: "01044445555" }, after: { name: "이력변경", phone: "01044445555" }, by: OWNER, at: AT });
    const asStaff = await api().listCustomerChanges(staff, { tenantId: T, customerId: customer.id });
    expect(asStaff.items[1]).toEqual({ id: expect.any(String), kind: "UPDATED", by: OWNER, at: AT });
    expect(JSON.stringify(asStaff)).not.toContain("0444");
  });
});
