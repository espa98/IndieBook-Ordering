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

describe("주문-고객 연결 (고객 결정 #4, Postgres)", () => {
  const ORDER = "b0000000-0000-4000-8000-0000000000f1";
  const ORDER_2 = "b0000000-0000-4000-8000-0000000000f2";

  it("직원이 주문에 고객을 연결하고 현재 고객을 읽는다(연결 전 null, 바꾸면 최신 연결, 같은 고객 재연결은 기록 없음, 다른 서점 주문 NOT_FOUND, 폐기된 주문 거부)", async () => {
    await q(`insert into public.ordering_orders (id, tenant_id) values ($1, $2), ($3, $2)`, [ORDER, T, ORDER_2]);
    const a = (await register(staff, { name: "연결고객A", phone: "010-3030-0001" })).customer;
    const b = (await register(staff, { name: "연결고객B", phone: "010-3030-0002" })).customer;
    const link = (actor: { userId: string }, orderId: string, customerId: string, tenantId = T) => api().linkOrderCustomer(actor, { tenantId, orderId, customerId, linkedAt: AT, idempotencyKey: key() } as never);

    expect(await api().getOrderCustomer(staff, { tenantId: T, orderId: ORDER })).toEqual({ customer: null });
    const first = await link(staff, ORDER, a.id);
    expect(first).toMatchObject({ orderId: ORDER, customerId: a.id, linkedBy: STAFF, linkedAt: AT });
    await link(staff, ORDER, a.id);
    expect(await q(`select 1 from public.ordering_order_customer_links where order_id = $1`, [ORDER])).toHaveLength(1);
    await link(owner, ORDER, b.id);
    expect(await api().getOrderCustomer(staff, { tenantId: T, orderId: ORDER })).toEqual({ customer: { id: b.id, name: "연결고객B", phone: "01030300002" }, linkedBy: OWNER, linkedAt: AT });

    expect(await codeOf(() => link({ userId: STRANGER }, ORDER, a.id))).toBe("FORBIDDEN");
    expect(await codeOf(() => link({ userId: STRANGER }, ORDER, a.id, T2))).toBe("NOT_FOUND");
    expect(await codeOf(() => link(staff, "not-a-uuid", a.id))).toBe("NOT_FOUND");
    await q(`update public.ordering_orders set version = version + 1, discarded_at = now(), discard_reason = '시험', discarded_by = 'x' where id = $1`, [ORDER_2]);
    expect(await codeOf(() => link(staff, ORDER_2, a.id))).toBe("BUSINESS_INVARIANT");
  });
});

describe("고객 목록 커서 페이지 (Postgres)", () => {
  it("limit만큼 최신순으로 자르고 nextCursor로 이어 받으면 겹침·누락 없이 전부 나오며(마지막 페이지엔 nextCursor 없음), 잘못된 커서는 VALIDATION_ERROR이다", async () => {
    const made: string[] = [];
    for (let i = 1; i <= 5; i++) made.push((await register(staff, { name: `페이지${i}`, phone: `010-9${i}00-0000` })).customer.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let guard = 0; guard < 5; guard++) {
      const page = await api().listCustomers(staff, { tenantId: T, search: "페이지", limit: 2, ...(cursor ? { cursor } : {}) } as never);
      sizes.push(page.items.length);
      seen.push(...page.items.map((i: { id: string }) => i.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual([...made].reverse());
    expect(await codeOf(() => api().listCustomers(staff, { tenantId: T, cursor: "garbage" } as never))).toBe("VALIDATION_ERROR");
  });
});

describe("고객 보존기간 적용 (고객 결정 #2, Postgres)", () => {
  const RT = "aaaaaaaa-0000-4000-8000-0000000000f3";
  const ROWNER = "11111111-0000-4000-8000-0000000000f3";
  const RSTAFF = "11111111-0000-4000-8000-0000000000f4";
  const apply = (actor: { userId: string }) => api().applyCustomerRetention(actor, { tenantId: RT, appliedAt: new Date().toISOString().replace(/\.\d+Z$/, ".000Z"), idempotencyKey: key() } as never);
  /** 시험 준비: 활동 시각을 과거로 돌린다(이력은 추가 전용이라 이 시험 연결에서만 트리거를 잠시 끈다) */
  const backdate = async (customerId: string, days: number) => {
    const c = await db.connect();
    try {
      await c.query("alter table public.ordering_customer_changes disable trigger ordering_customer_changes_append_only");
      await c.query("update public.ordering_customer_changes set recorded_at = now() - make_interval(days => $2) where customer_id = $1", [customerId, days]);
      await c.query("alter table public.ordering_customer_changes enable trigger ordering_customer_changes_append_only");
      await c.query("update public.ordering_customers set created_at = now() - make_interval(days => $2) where id = $1", [customerId, days]);
    } finally {
      await c.end();
    }
  };

  it("Owner만 실행하고(직원 FORBIDDEN), 보존기간이 없으면 거부하며, 기한을 넘긴 고객만 익명화한다(최근 변경·주문 연결이 있으면 활동 중으로 본다)", async () => {
    await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '보존서점', $2)`, [RT, ROWNER]);
    await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [RT, ROWNER, RSTAFF]);
    const make = async (name: string, phone: string) => (await register({ userId: ROWNER }, { name, phone }, RT)).customer;
    const stale = await make("만료고객", "010-4100-0001");
    const touched = await make("수정으로활동중", "010-4100-0002");
    const linked = await make("연결로활동중", "010-4100-0003");
    const fresh = await make("최근고객", "010-4100-0004");
    for (const c of [stale, touched, linked]) await backdate(c.id, 400);
    await api().updateCustomer({ userId: ROWNER }, { tenantId: RT, customerId: touched.id, expectedVersion: 1, changes: { name: "수정으로활동중" }, changedAt: AT, idempotencyKey: key() } as never);
    const ORD = "b0000000-0000-4000-8000-0000000000f9";
    await q(`insert into public.ordering_orders (id, tenant_id) values ($1, $2)`, [ORD, RT]);
    await api().linkOrderCustomer({ userId: ROWNER }, { tenantId: RT, orderId: ORD, customerId: linked.id, linkedAt: AT, idempotencyKey: key() } as never);

    expect(await codeOf(() => apply({ userId: RSTAFF }))).toBe("FORBIDDEN");
    await q(`update public.ordering_tenants set customer_retention_days = null where id = $1`, [RT]); // 기본은 15일이므로 먼저 해제한다
    expect(await codeOf(() => apply({ userId: ROWNER }))).toBe("BUSINESS_INVARIANT"); // 보존기간 없음
    await q(`update public.ordering_tenants set customer_retention_days = 365 where id = $1`, [RT]);

    const result = await apply({ userId: ROWNER });

    expect(result).toMatchObject({ retentionDays: 365, anonymizedCustomerIds: [stale.id], hasMore: false });
    const states = await q(`select name, anonymized_at is not null as anonymized from public.ordering_customers where tenant_id = $1 and id <> $2 order by created_at`, [RT, "00000000-0000-4000-8000-000000000000"]);
    expect(states.map((r: any) => [r.anonymized])).toEqual([[true], [false], [false], [false]]);
    expect((await q(`select by_ok from (select "by" = $2 as by_ok from public.ordering_customer_changes where customer_id = $1 and kind = 'ANONYMIZED') x`, [stale.id, ROWNER]))[0]).toEqual({ by_ok: true });
    expect(fresh.id).toBeDefined();
  });

  it("열려 있는 주문에 연결된 고객은 오래돼도 익명화하지 않고, 그 주문이 폐기·종결되면 대상이 된다", async () => {
    const make = async (name: string, phone: string) => (await register({ userId: ROWNER }, { name, phone }, RT)).customer;
    const holder = await make("열린주문고객", "010-4200-0001");
    const ORD = "b0000000-0000-4000-8000-0000000000fa";
    await q(`insert into public.ordering_orders (id, tenant_id) values ($1, $2)`, [ORD, RT]);
    await api().linkOrderCustomer({ userId: ROWNER }, { tenantId: RT, orderId: ORD, customerId: holder.id, linkedAt: AT, idempotencyKey: key() } as never);
    // 활동 시각(등록·연결 기록)을 모두 과거로 돌린다
    const c = await db.connect();
    await c.query("alter table public.ordering_customer_changes disable trigger ordering_customer_changes_append_only");
    await c.query("alter table public.ordering_order_customer_links disable trigger ordering_order_customer_links_append_only");
    await c.query("update public.ordering_customer_changes set recorded_at = now() - interval '400 days' where customer_id = $1", [holder.id]);
    await c.query("update public.ordering_order_customer_links set recorded_at = now() - interval '400 days' where customer_id = $1", [holder.id]);
    await c.query("alter table public.ordering_customer_changes enable trigger ordering_customer_changes_append_only");
    await c.query("alter table public.ordering_order_customer_links enable trigger ordering_order_customer_links_append_only");
    await c.query("update public.ordering_customers set created_at = now() - interval '400 days' where id = $1", [holder.id]);
    await c.end();

    expect((await apply({ userId: ROWNER })).anonymizedCustomerIds).not.toContain(holder.id);
    await q(`update public.ordering_orders set version = version + 1, discarded_at = now(), discard_reason = '시험', discarded_by = 'x' where id = $1`, [ORD]);
    expect((await apply({ userId: ROWNER })).anonymizedCustomerIds).toContain(holder.id);
  });
});
