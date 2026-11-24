import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres, withJwt } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const OWNER_A2 = "11111111-0000-4000-8000-000000000011";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(
    `insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`,
    [T_A, OWNER_A, T_B, OWNER_B],
  );
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values
       ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false), ($5, $6, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, EX_STAFF_A, T_B, OWNER_B],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const authed = (sub: string, extra: Record<string, unknown> = {}) => ({
  role: "authenticated" as const,
  claims: { sub, ...extra },
});

describe("테넌트·멤버십 RLS (RLS V2.2, T7)", () => {
  it("비로그인(anon)은 테이블 권한이 없어 조회·변경이 모두 42501로 거부된다", async () => {
    const c = await db.connect();
    try {
      for (const sql of [
        "select * from public.ordering_tenants",
        "select * from public.ordering_members",
        "insert into public.ordering_tenants (name, owner_user_id) values ('x', gen_random_uuid())",
      ]) {
        expect(await withJwt(c, { role: "anon", claims: null }, () => sqlState(() => c.query(sql))), sql).toBe("42501");
      }
    } finally {
      await c.end();
    }
  });

  it("로그인했어도 멤버가 아니면 아무 행도 보이지 않고, 활성 멤버는 자기 서점만 본다 (다른 서점 UUID를 지정해도 0행)", async () => {
    const c = await db.connect();
    try {
      const tenantsFor = async (sub: string) =>
        withJwt(c, authed(sub), async () =>
          (await c.query("select id from public.ordering_tenants order by name")).rows.map((r) => r.id),
        );

      expect(await tenantsFor(STRANGER)).toEqual([]);
      expect(await tenantsFor(OWNER_A)).toEqual([T_A]);
      expect(await tenantsFor(STAFF_A)).toEqual([T_A]);
      expect(await tenantsFor(OWNER_B)).toEqual([T_B]);
      const other = await withJwt(c, authed(OWNER_A), async () =>
        (await c.query("select id from public.ordering_tenants where id = $1", [T_B])).rows,
      );
      expect(other).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("비활성 직원은 즉시 아무것도 볼 수 없고, JWT에 OWNER 역할 클레임을 넣어도 멤버십만 믿는다 (RLS-07)", async () => {
    const c = await db.connect();
    try {
      const rows = (sub: string, claims: Record<string, unknown> = {}) =>
        withJwt(c, authed(sub, claims), async () => (await c.query("select id from public.ordering_tenants")).rows);

      expect(await rows(EX_STAFF_A)).toEqual([]);
      expect(await rows(EX_STAFF_A, { role: "OWNER", app_metadata: { role: "OWNER", tenant_id: T_A } })).toEqual([]);
      expect(await rows(STRANGER, { user_role: "OWNER", tenant_id: T_A })).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("Owner는 서점 구성원 전체를, Staff는 자기 행만 본다. 활성이 아닌 행은 본인에게도 보이지 않는다", async () => {
    const c = await db.connect();
    try {
      const members = (sub: string) =>
        withJwt(c, authed(sub), async () =>
          (await c.query("select user_id from public.ordering_members order by user_id")).rows.map((r) => r.user_id),
        );

      expect(await members(OWNER_A)).toEqual([OWNER_A, STAFF_A, EX_STAFF_A]); // 비활성 구성원도 Owner는 관리 목적으로 본다
      expect(await members(STAFF_A)).toEqual([STAFF_A]);
      expect(await members(EX_STAFF_A)).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("authenticated는 테넌트·멤버십을 직접 INSERT·UPDATE·DELETE할 수 없다 (쓰기는 서버 경로만)", async () => {
    const c = await db.connect();
    try {
      for (const sql of [
        `insert into public.ordering_members (tenant_id, user_id, role) values ('${T_A}', gen_random_uuid(), 'OWNER')`,
        `update public.ordering_members set role = 'OWNER' where user_id = '${STAFF_A}'`,
        `delete from public.ordering_members where user_id = '${STAFF_A}'`,
        `update public.ordering_tenants set name = '해킹' where id = '${T_A}'`,
      ]) {
        expect(await withJwt(c, authed(OWNER_A), () => sqlState(() => c.query(sql))), sql).toBe("42501");
      }
    } finally {
      await c.end();
    }
  });

  it("멤버십 헬퍼는 SECURITY DEFINER에 search_path가 고정되어 있고 anon은 실행할 수 없다 (RLS-02·05)", async () => {
    const c = await db.connect();
    try {
      const fn = (
        await c.query(
          `select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname = 'is_ordering_member'`,
        )
      ).rows[0];
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain('search_path=""'); // 빈 경로로 고정
      expect(fn.anon_exec).toBe(false);
      expect(fn.auth_exec).toBe(true);
    } finally {
      await c.end();
    }
  });

  it("마지막 활성 Owner는 DB 수준에서도 비활성화·강등·삭제할 수 없다 (BR-T06)", async () => {
    const c = await db.connect();
    try {
      expect(
        await sqlState(() => c.query(`update public.ordering_members set active = false where tenant_id = '${T_A}' and user_id = '${OWNER_A}'`)),
      ).toBe("P0001");
      expect(
        await sqlState(() => c.query(`update public.ordering_members set role = 'STAFF' where tenant_id = '${T_A}' and user_id = '${OWNER_A}'`)),
      ).toBe("P0001");
      expect(
        await sqlState(() => c.query(`delete from public.ordering_members where tenant_id = '${T_A}' and user_id = '${OWNER_A}'`)),
      ).toBe("P0001");
      expect((await c.query(`select active from public.ordering_members where user_id = '${OWNER_A}'`)).rows[0].active).toBe(true);
    } finally {
      await c.end();
    }
  });

  it("두 독립 세션이 Owner 두 명을 동시에 비활성화하면 하나만 성공하고 활성 Owner가 1명 남는다", async () => {
    const setup = await db.connect();
    await setup.query(`insert into public.ordering_members (tenant_id, user_id, role) values ('${T_A}', '${OWNER_A2}', 'OWNER')`);
    await setup.end();
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      await a.query(`update public.ordering_members set active = false where tenant_id = '${T_A}' and user_id = '${OWNER_A}'`);
      const second = sqlState(() =>
        b.query(`update public.ordering_members set active = false where tenant_id = '${T_A}' and user_id = '${OWNER_A2}'`),
      );
      await a.query("commit"); // b는 a의 잠금이 풀린 뒤 다시 검사한다
      expect(await second).toBe("P0001");
      await b.query("rollback");
      const check = await db.connect();
      const active = (
        await check.query(`select user_id from public.ordering_members where tenant_id = '${T_A}' and role = 'OWNER' and active`)
      ).rows;
      await check.end();
      expect(active.map((r) => r.user_id)).toEqual([OWNER_A2]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
