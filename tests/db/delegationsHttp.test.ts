import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** POST /members/{id}/delegations, GET /delegations (S-03): Owner만. 위임이 실제 권한을 바꾸는지 HTTP로 끝까지 확인한다 */
const SECRET = "delegations-secret-0123456789abcdef012";
const T = "aaaaaaaa-0000-4000-8000-0000000000e1";
const OWNER = "11111111-0000-4000-8000-0000000000e1";
const STAFF = "11111111-0000-4000-8000-0000000000e2";
const STRANGER = "99999999-0000-4000-8000-0000000000e1";

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
function call(method: "GET" | "POST", path: string, sub: string | undefined, body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") headers["idempotency-key"] = `dh-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}
const supplier = (sub: string, code: string) => call("POST", "/suppliers", sub, { code, name: `공급처 ${code}`, orderChannel: "EMAIL", registeredAt: "2026-03-04T06:00:00.000Z" });

describe("위임 HTTP", () => {
  it("Owner가 위임을 부여하면 직원이 공급처를 등록할 수 있고, 회수하면 다시 403이다. 목록에는 현재 위임만 나온다", async () => {
    expect((await supplier(STAFF, "alpha")).status).toBe(403);

    const granted = await call("POST", `/members/${STAFF}/delegations`, OWNER, { kind: "MANAGEMENT", delegated: true });
    expect(granted.status).toBe(200);
    expect(granted.body.data).toMatchObject({ userId: STAFF, kind: "MANAGEMENT", delegated: true, changedBy: OWNER });
    expect((await supplier(STAFF, "alpha")).status).toBe(201);

    const list = await call("GET", "/delegations", OWNER);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([{ userId: STAFF, kind: "MANAGEMENT", delegatedBy: OWNER, delegatedAt: expect.any(String) }]);

    expect((await call("POST", `/members/${STAFF}/delegations`, OWNER, { kind: "MANAGEMENT", delegated: false })).status).toBe(200);
    expect((await supplier(STAFF, "beta")).status).toBe(403);
    expect((await call("GET", "/delegations", OWNER)).body.data).toEqual([]);
  });

  it("직원·비멤버는 403, 인증 없음은 401, 알 수 없는 필드(행위자·역할 포함)·잘못된 값은 400, 이미 그 상태·Owner 대상은 422, 없는 대상은 404", async () => {
    expect((await call("POST", `/members/${STAFF}/delegations`, STAFF, { kind: "MANAGEMENT", delegated: true })).status).toBe(403);
    expect((await call("POST", `/members/${STAFF}/delegations`, STRANGER, { kind: "MANAGEMENT", delegated: true })).status).toBe(403);
    expect((await call("POST", `/members/${STAFF}/delegations`, undefined, { kind: "MANAGEMENT", delegated: true })).status).toBe(401);
    for (const body of [{ kind: "MANAGEMENT", delegated: true, actorRole: "OWNER" }, { kind: "MANAGEMENT", delegated: true, changedBy: "x" }, { kind: "ALL", delegated: true }, { kind: "MANAGEMENT", delegated: "true" }, { kind: "MANAGEMENT" }]) {
      expect((await call("POST", `/members/${STAFF}/delegations`, OWNER, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", `/members/${STAFF}/delegations`, OWNER, { kind: "STOCK_ADJUSTMENT", delegated: false })).status).toBe(422); // 부여된 적 없음
    expect((await call("POST", `/members/${OWNER}/delegations`, OWNER, { kind: "MANAGEMENT", delegated: true })).status).toBe(422);
    expect((await call("POST", `/members/${STRANGER}/delegations`, OWNER, { kind: "MANAGEMENT", delegated: true })).status).toBe(404);
    expect((await call("POST", "/members/not-a-uuid/delegations", OWNER, { kind: "MANAGEMENT", delegated: true })).status).toBe(404);

    for (const [sub, status] of [[STAFF, 403], [STRANGER, 403], [undefined, 401]] as const) expect((await call("GET", "/delegations", sub)).status, String(sub)).toBe(status);
    expect((await call("POST", "/delegations", OWNER, {})).status).toBe(405);
  });
});
