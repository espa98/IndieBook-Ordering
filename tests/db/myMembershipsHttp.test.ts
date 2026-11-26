import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /v1/me/memberships: 계정 범위(서점 접두어 없음), 로그인한 누구나(이메일 claim 불필요), 본인의 활성 서점만 */
const SECRET = "memberships-secret-0123456789abcdef012";
const ME = "66666666-0000-4000-8000-0000000000b1";
const OTHER = "66666666-0000-4000-8000-0000000000b2";
const T1 = "aaaaaaaa-0000-4000-8000-0000000000b1";
const T2 = "aaaaaaaa-0000-4000-8000-0000000000b2";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '내 서점', $2), ($3, '남의 서점', $4)`, [T1, ME, T2, OTHER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($3, $4, 'OWNER', true)`, [T1, ME, T2, OTHER]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

function call(method: "GET" | "POST", sub: string | undefined, query = "", extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now, ...extra }, SECRET, { kid: "k1" })}`;
  return app({ method, path: "/v1/me/memberships", query: new URLSearchParams(query), headers, rawBody: undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /v1/me/memberships", () => {
  it("본인의 활성 서점과 역할만 돌려주고(이메일 claim이 없어도), 서점이 없는 계정은 빈 목록이다", async () => {
    const mine = await call("GET", ME);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ data: [{ tenantId: T1, tenantName: "내 서점", role: "OWNER" }] });
    expect(JSON.stringify(mine.body)).not.toContain(T2);
    expect((await call("GET", "66666666-0000-4000-8000-0000000000b3")).body).toEqual({ data: [] });
  });

  it("인증이 없으면 401, POST는 405, 알 수 없는 쿼리는 400, 토큰의 역할·서점 claim은 무시된다", async () => {
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", ME)).status).toBe(405);
    expect((await call("GET", ME, "tenantId=" + T2)).status).toBe(400);
    const forged = await call("GET", ME, "", { app_metadata: { tenant_id: T2, role: "OWNER" }, tenant_id: T2 });
    expect(forged.body).toEqual({ data: [{ tenantId: T1, tenantName: "내 서점", role: "OWNER" }] });
  });
});
