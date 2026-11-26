import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres, withJwt } from "../helpers/migratedPostgres";

const T = "aaaaaaaa-0000-4000-8000-0000000000b1";
const OWNER = "11111111-0000-4000-8000-0000000000b1";
const STAFF = "11111111-0000-4000-8000-0000000000b2";

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
  await q(`insert into public.ordering_customers (tenant_id, name, phone) values ($1, '고객', '01000000001')`, [T]);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("서점 상태 스키마 (035)", () => {
  it("서점 상태는 ACTIVE·SUSPENDED·TERMINATED만 허용하고, 중지·해지된 서점은 RLS 헬퍼가 멤버로 인정하지 않아 직접 읽기도 막힌다", async () => {
    const readCustomers = async (sub: string) => {
      const c = await db.connect();
      try {
        return await withJwt(c, { role: "authenticated", claims: { sub } }, async () => (await c.query("select 1 from public.ordering_customers")).rows.length);
      } finally {
        await c.end();
      }
    };

    expect(await readCustomers(STAFF)).toBe(1);
    expect(await sqlState(() => q(`update public.ordering_tenants set status = 'CLOSED' where id = $1`, [T]))).toBe("23514");
    await q(`update public.ordering_tenants set status = 'SUSPENDED' where id = $1`, [T]);
    expect(await readCustomers(STAFF)).toBe(0);
    expect(await readCustomers(OWNER)).toBe(0);
    await q(`update public.ordering_tenants set status = 'ACTIVE' where id = $1`, [T]);
    expect(await readCustomers(STAFF)).toBe(1);
  });

  it("상태 변경 이력은 추가 전용이고(같은 상태로의 변경·빈 사유 거부), 서점이 중지된 동안에도 Owner만 읽고 직원은 읽지 못하며 클라이언트는 쓸 수 없다", async () => {
    await q(`insert into public.ordering_tenant_status_changes (tenant_id, kind, from_status, to_status, reason, "by", "at") values ($1, 'DEACTIVATED', 'ACTIVE', 'SUSPENDED', '중단', 'owner', now())`, [T]);
    expect(await sqlState(() => q(`insert into public.ordering_tenant_status_changes (tenant_id, kind, from_status, to_status, reason, "by", "at") values ($1, 'DEACTIVATED', 'ACTIVE', 'ACTIVE', 'x', 'o', now())`, [T]))).toBe("23514");
    expect(await sqlState(() => q(`insert into public.ordering_tenant_status_changes (tenant_id, kind, from_status, to_status, reason, "by", "at") values ($1, 'DEACTIVATED', 'ACTIVE', 'SUSPENDED', ' ', 'o', now())`, [T]))).toBe("23514");
    expect(await sqlState(() => q(`update public.ordering_tenant_status_changes set reason = 'x'`))).toBe("P0001");
    expect(await sqlState(() => q(`delete from public.ordering_tenant_status_changes`))).toBe("P0001");

    await q(`update public.ordering_tenants set status = 'SUSPENDED' where id = $1`, [T]);
    const read = async (sub: string) => {
      const c = await db.connect();
      try {
        return await withJwt(c, { role: "authenticated", claims: { sub } }, async () => (await c.query("select 1 from public.ordering_tenant_status_changes")).rows.length);
      } finally {
        await c.end();
      }
    };
    expect(await read(OWNER)).toBe(1);
    expect(await read(STAFF)).toBe(0);
    const c = await db.connect();
    try {
      expect(await withJwt(c, { role: "authenticated", claims: { sub: OWNER } }, () => sqlState(() => c.query(`insert into public.ordering_tenant_status_changes (tenant_id, kind, from_status, to_status, reason, "by", "at") values ('${T}', 'REACTIVATED', 'SUSPENDED', 'ACTIVE', 'x', 'o', now())`)))).toBe("42501");
    } finally {
      await c.end();
    }
    await q(`update public.ordering_tenants set status = 'ACTIVE' where id = $1`, [T]);
  });
});
