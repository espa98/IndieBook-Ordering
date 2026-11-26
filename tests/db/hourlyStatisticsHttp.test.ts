import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /statistics/hourly (DASH-007): 활성 멤버(Owner·직원) 읽기 전용. 수치 검증은 pgHourlyStatistics가 한다 */
const SECRET = "hourly-stats-secret-0123456789abcdef01";
const T = "aaaaaaaa-0000-4000-8000-0000000000bd";
const OWNER = "11111111-0000-4000-8000-0000000000bd";
const STAFF = "11111111-0000-4000-8000-0000000000be";
const EX_STAFF = "11111111-0000-4000-8000-0000000000bf";
const STRANGER = "99999999-0000-4000-8000-0000000000bd";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  const order = (await c.query(`insert into public.ordering_orders (tenant_id, status, created_at) values ($1, 'DRAFT', $2) returning id`, [T, new Date("2026-03-04T10:00:00+09:00").toISOString()])).rows[0].id as string;
  await c.query(`insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw) values ($1, $2, 1, 'b', 3, 1000)`, [T, order]);
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
  if (method === "POST") Object.assign(headers, { "idempotency-key": "hs-1", "content-type": "application/json" });
  return app({ method, path: `/v1/tenants/${T}/statistics/hourly`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /statistics/hourly", () => {
  it("직원도 09~22시 13칸 통계를 읽고, 기간·쿼리를 검증한다", async () => {
    const res = await call("GET", STAFF, "from=2026-03-04&to=2026-03-04");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ timezone: "Asia/Seoul", from: "2026-03-04", to: "2026-03-04" });
    expect(res.body.data.hours).toHaveLength(13);
    expect(res.body.data.hours.find((h: { hour: number }) => h.hour === 10).orders).toEqual({ count: 1, quantity: 3 });
    expect((await call("GET", OWNER)).status).toBe(200); // 기간 생략 = 최근 30일
    for (const query of ["from=2026-3-4", "to=2026-02-30", "from=2026-03-05&to=2026-03-04", "from=2024-01-01&to=2026-03-04", "x=1"]) expect((await call("GET", OWNER, query)).status, query).toBe(400);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", sub)).status, sub).toBe(403);
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", OWNER)).status).toBe(405);
  });
});
