import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres, withJwt } from "../helpers/migratedPostgres";

const T = "aaaaaaaa-0000-4000-8000-0000000000e1";
const OWNER = "11111111-0000-4000-8000-0000000000e1";
const STAFF = "11111111-0000-4000-8000-0000000000e2";
const STRANGER = "99999999-0000-4000-8000-0000000000e1";
const C1 = "c0000000-0000-4000-8000-0000000000e1";

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T, OWNER, STAFF]);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("고객 스키마 (031)", () => {
  it("고객은 이름과 정규화된 국내 번호로 저장되고, 형식이 틀린 번호는 거부된다", async () => {
    await q(`insert into public.ordering_customers (id, tenant_id, name, phone) values ($1, $2, '김독자', '01012345678')`, [C1, T]);
    expect((await q(`select name, phone, version from public.ordering_customers where id = $1`, [C1]))[0]).toEqual({ name: "김독자", phone: "01012345678", version: 1 });

    const state = await sqlState(() => q(`insert into public.ordering_customers (tenant_id, name, phone) values ($1, '이상한', '010-1234')`, [T]));
    expect(state).toBe("23514");
  });

  it("변경 이력은 추가 전용이다(수정·삭제 거부)", async () => {
    await q(`insert into public.ordering_customer_changes (id, tenant_id, customer_id, kind, after, "by", "at") values ($1, $2, $3, 'REGISTERED', '{"name":"김독자"}', 'staff-1', now())`, ["d0000000-0000-4000-8000-0000000000e1", T, C1]);

    expect(await sqlState(() => q(`update public.ordering_customer_changes set "by" = 'x'`))).toBe("P0001");
    expect(await sqlState(() => q(`delete from public.ordering_customer_changes`))).toBe("P0001");
  });

  it("RLS: 서점 멤버만 고객을 읽고, 이력은 Owner만 읽으며, 로그인 사용자의 직접 쓰기는 막힌다", async () => {
    const as = async (userId: string, sql: string) => {
      const c = await db.connect();
      try {
        return await withJwt(c, { role: "authenticated", claims: { sub: userId } }, async () => (await c.query(sql)).rows.length);
      } finally {
        await c.end();
      }
    };
    expect(await as(STAFF, "select 1 from public.ordering_customers")).toBe(1);
    expect(await as(STRANGER, "select 1 from public.ordering_customers")).toBe(0);
    expect(await as(OWNER, "select 1 from public.ordering_customer_changes")).toBe(1);
    expect(await as(STAFF, "select 1 from public.ordering_customer_changes")).toBe(0);
    expect(await sqlState(() => as(OWNER, `insert into public.ordering_customers (tenant_id, name, phone) values ('${T}', 'x', '01000000000')`))).toBe("42501");
  });
});
