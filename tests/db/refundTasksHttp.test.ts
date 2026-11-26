import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /refund-tasks (O-09-04 환급 필요 업무): 활성 멤버(Owner·직원) 읽기 전용 */
const SECRET = "refund-tasks-secret-0123456789abcdef01";
const T = "aaaaaaaa-0000-4000-8000-0000000000d9";
const OWNER = "11111111-0000-4000-8000-0000000000d9";
const STAFF = "11111111-0000-4000-8000-0000000000da";
const EX_STAFF = "11111111-0000-4000-8000-0000000000db";
const STRANGER = "99999999-0000-4000-8000-0000000000d9";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
const taskIds: string[] = [];
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  for (const [n, at, required] of [[1, "2026-03-01T00:00:00Z", 10000], [2, "2026-03-02T00:00:00Z", 2000]] as const) {
    const order = (await c.query(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ($1, 'CONFIRMED', $2, 50000) returning id`, [T, n])).rows[0].id as string;
    taskIds.push((await c.query(`insert into public.ordering_refund_tasks (tenant_id, order_id, required_krw, opened_by, opened_at) values ($1, $2, $3, 'u', $4) returning id`, [T, order, required, at])).rows[0].id as string);
  }
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
  if (method === "POST") Object.assign(headers, { "idempotency-key": "t-1", "content-type": "application/json" });
  return app({ method, path: `/v1/tenants/${T}/refund-tasks`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /refund-tasks", () => {
  it("직원도 환급 업무를 최신 개시 순으로 읽고, 필터·페이지·쿼리 검증이 동작한다", async () => {
    const list = await call("GET", STAFF);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i: { id: string }) => i.id)).toEqual([taskIds[1], taskIds[0]]);
    expect(list.body.data.items[0]).toEqual({
      id: taskIds[1], orderId: expect.any(String), orderDisplayNumber: 2, requiredKrw: "2000", refundedKrw: "0", remainingKrw: "2000", status: "REFUND_REQUIRED",
      openedAt: "2026-03-02T00:00:00.000Z", pendingRequests: 0, unresolvedAttempts: 0,
    });
    expect((await call("GET", OWNER, "status=REFUND_REQUIRED&open=true")).body.data.items).toHaveLength(2);
    expect((await call("GET", OWNER, "status=REFUNDED")).body.data.items).toEqual([]);
    const first = await call("GET", OWNER, "limit=1");
    expect((await call("GET", OWNER, `limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)).body.data.items.map((i: { id: string }) => i.id)).toEqual([taskIds[0]]);
    for (const query of ["status=DONE", "open=yes", "limit=0", "limit=x", "cursor=%25%25", "x=1"]) expect((await call("GET", OWNER, query)).status, query).toBe(400);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", sub)).status, sub).toBe(403);
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", OWNER)).status).toBe(405);
  });
});
