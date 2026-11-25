import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres, withJwt } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const OWNER_B = "22222222-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($4, $5, 'OWNER', true)`, [T_A, OWNER_A, STAFF_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_audit_log (tenant_id, actor_id, operation, command_key, request_hash) values ($1, $2, 'POST /v1/tenants/{tenantId}/orders', 'k-1', $3), ($4, $5, 'POST /v1/tenants/{tenantId}/orders', 'k-2', $3)`,
    [T_A, STAFF_A, "a".repeat(64), T_B, OWNER_B],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const authed = (sub: string) => ({ role: "authenticated" as const, claims: { sub } });

describe("감사 로그 스키마 (ordering_audit_log)", () => {
  it("추가 전용이고(수정·삭제 거부), 서점 Owner만 자기 서점의 기록을 읽고 직원·타 서점·비로그인은 읽지 못하며, 클라이언트 역할은 쓸 수 없다", async () => {
    const c = await db.connect();
    try {
      expect(await sqlState(() => c.query(`update public.ordering_audit_log set command_key = 'x'`))).toBe("P0001");
      expect(await sqlState(() => c.query(`delete from public.ordering_audit_log`))).toBe("P0001");
      expect(await sqlState(() => c.query(`insert into public.ordering_audit_log (tenant_id, actor_id, operation, request_hash) values ($1, $2, '', $3)`, [T_A, OWNER_A, "a".repeat(64)]))).toBe("23514"); // 빈 작업명
      expect(await sqlState(() => c.query(`insert into public.ordering_audit_log (tenant_id, actor_id, operation, request_hash) values ($1, $2, 'x', 'not-a-hash')`, [T_A, OWNER_A]))).toBe("23514");

      const seen = (sub: string) => withJwt(c, authed(sub), async () => (await c.query("select command_key from public.ordering_audit_log order by command_key")).rows.map((r) => r.command_key));
      expect(await seen(OWNER_A)).toEqual(["k-1"]);
      expect(await seen(STAFF_A)).toEqual([]);
      expect(await seen(OWNER_B)).toEqual(["k-2"]);
      expect(await withJwt(c, { role: "anon", claims: null }, () => sqlState(() => c.query("select * from public.ordering_audit_log")))).toBe("42501");
      expect(await withJwt(c, authed(OWNER_A), () => sqlState(() => c.query(`insert into public.ordering_audit_log (tenant_id, actor_id, operation, request_hash) values ($1, $2, 'x', $3)`, [T_A, OWNER_A, "a".repeat(64)])))).toBe("42501");
    } finally {
      await c.end();
    }
  });
});
