import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /members, GET /staff-invitations (S-02): Owner만, 토큰은 초대 응답에만 있고 목록에는 없다 */
const SECRET = "staff-lists-secret-0123456789abcdef012";
const T = "aaaaaaaa-0000-4000-8000-0000000000d1";
const OWNER = "11111111-0000-4000-8000-0000000000d1";
const STAFF = "11111111-0000-4000-8000-0000000000d2";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T, OWNER, STAFF]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
function call(method: "GET" | "POST", path: string, sub: string | undefined, query = "", body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") headers["idempotency-key"] = `sl-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(query), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("직원·초대 목록 HTTP", () => {
  it("Owner는 직원 목록과 초대 목록(방금 보낸 초대는 PENDING, 토큰 없음)을 본다", async () => {
    const invited = await call("POST", "/staff-invitations", OWNER, "", { email: "new@shop.test", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(invited.status).toBe(201);
    const token = invited.body.data.token as string;

    const members = await call("GET", "/members", OWNER);
    expect(members.status).toBe(200);
    expect(members.body.data.map((m: { userId: string; role: string }) => [m.userId, m.role])).toEqual([[OWNER, "OWNER"], [STAFF, "STAFF"]]);

    const invitations = await call("GET", "/staff-invitations", OWNER);
    expect(invitations.status).toBe(200);
    expect(invitations.body.data).toHaveLength(1);
    expect(invitations.body.data[0]).toMatchObject({ email: "new@shop.test", status: "PENDING", invitedBy: OWNER });
    expect(JSON.stringify(invitations.body)).not.toContain(token);
    expect(JSON.stringify(invitations.body)).not.toMatch(/token/i);
  });

  it("직원은 403, 인증 없음은 401, 알 수 없는 쿼리는 400, POST는 405, 직원 비활성화 뒤에는 목록에 비활성으로 나온다", async () => {
    for (const path of ["/members", "/staff-invitations"]) {
      expect((await call("GET", path, STAFF)).status, `직원 ${path}`).toBe(403);
      expect((await call("GET", path, undefined)).status, `무인증 ${path}`).toBe(401);
      expect((await call("GET", path, OWNER, "x=1")).status, `쿼리 ${path}`).toBe(400);
    }
    expect((await call("POST", "/members", OWNER, "", {})).status).toBe(405);
    expect((await call("POST", `/members/${STAFF}/status`, OWNER, "", { status: "INACTIVE" })).status).toBe(200);
    const members = (await call("GET", "/members", OWNER)).body.data as { userId: string; status: string }[];
    expect(members.find((m) => m.userId === STAFF)?.status).toBe("INACTIVE");
  });
});
