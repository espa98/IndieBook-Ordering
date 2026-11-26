import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /supplier-overview (DASH-006 공급처별 발주·입고 현황): 활성 멤버(Owner·직원) 읽기 전용. 수치 검증은 pgSupplierOverview가 한다 */
const SECRET = "supplier-overview-secret-0123456789ab";
const T = "aaaaaaaa-0000-4000-8000-0000000000ad";
const OWNER = "11111111-0000-4000-8000-0000000000ad";
const STAFF = "11111111-0000-4000-8000-0000000000ae";
const EX_STAFF = "11111111-0000-4000-8000-0000000000af";
const STRANGER = "99999999-0000-4000-8000-0000000000ad";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  await c.query(`insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel) values ($1, 'alpha', true, '알파 도매', 'EMAIL'), ($1, 'beta', false, '베타 유통', 'WEB')`, [T]);
  await c.query(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'alpha', 'DRAFT', 1)`, [T]);
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
  if (method === "POST") Object.assign(headers, { "idempotency-key": "so-1", "content-type": "application/json" });
  return app({ method, path: `/v1/tenants/${T}/supplier-overview`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /supplier-overview", () => {
  it("직원도 공급처별 현황을 코드순으로 읽고 delayDays·쿼리를 검증한다", async () => {
    const res = await call("GET", STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { code: string }) => i.code)).toEqual(["alpha", "beta"]);
    expect(res.body.data.items[0]).toMatchObject({ name: "알파 도매", active: true, purchaseOrders: { draft: 1, sent: 0 }, openRemainingQuantity: 0 });
    expect((await call("GET", OWNER, "delayDays=3")).status).toBe(200);
    for (const query of ["delayDays=0", "delayDays=366", "delayDays=abc", "x=1"]) expect((await call("GET", OWNER, query)).status, query).toBe(400);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", sub)).status, sub).toBe(403);
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", OWNER)).status).toBe(405);
  });
});
