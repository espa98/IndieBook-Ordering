import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /allocation-cancellations (R-01·R-03 취소 물량 처분 현황): 활성 멤버(Owner·직원) 읽기 전용. 내용 검증은 pgDispositionRead·responseContract가 한다 */
const SECRET = "allocation-cancellations-secret-0123456";
const T = "aaaaaaaa-0000-4000-8000-0000000000f9";
const OWNER = "11111111-0000-4000-8000-0000000000f9";
const STAFF = "11111111-0000-4000-8000-0000000000fa";
const EX_STAFF = "11111111-0000-4000-8000-0000000000fb";
const STRANGER = "99999999-0000-4000-8000-0000000000f9";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

function call(method: "GET" | "POST", sub: string | undefined, query = "") {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") Object.assign(headers, { "idempotency-key": "c-1", "content-type": "application/json" });
  return app({ method, path: `/v1/tenants/${T}/allocation-cancellations`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /allocation-cancellations", () => {
  it("직원도 빈 목록을 읽고, open·limit·cursor 쿼리를 검증하며 알 수 없는 쿼리는 400이다", async () => {
    expect((await call("GET", STAFF)).body).toEqual({ data: { items: [] } });
    expect((await call("GET", OWNER, "open=true")).body.data.items).toEqual([]);
    expect((await call("GET", OWNER, "open=false")).status).toBe(200);
    for (const query of ["open=yes", "open=1", "limit=0", "limit=x", "cursor=%25%25", "x=1"]) expect((await call("GET", OWNER, query)).status, query).toBe(400);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", sub)).status, sub).toBe(403);
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", OWNER)).status).toBe(405);
  });
});
