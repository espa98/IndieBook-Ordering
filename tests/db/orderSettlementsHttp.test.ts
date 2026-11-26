import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /order-settlements (O-09 수령·결제 현황): 활성 멤버(Owner·직원) 읽기 전용 */
const SECRET = "settlements-secret-0123456789abcdef012";
const T = "aaaaaaaa-0000-4000-8000-0000000000b9";
const OWNER = "11111111-0000-4000-8000-0000000000b9";
const STAFF = "11111111-0000-4000-8000-0000000000ba";
const EX_STAFF = "11111111-0000-4000-8000-0000000000bb";
const STRANGER = "99999999-0000-4000-8000-0000000000b9";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
const orderIds: string[] = [];
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  for (const [n, at, closed] of [[1, "2026-03-01T00:00:00Z", false], [2, "2026-03-02T00:00:00Z", false], [3, "2026-03-03T00:00:00Z", true]] as const) {
    const id = (await c.query(`insert into public.ordering_orders (tenant_id, status, created_at) values ($1, 'DRAFT', $2) returning id`, [T, at])).rows[0].id as string;
    await c.query(`insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw) values ($1, $2, 1, 'b', 2, 10000)`, [T, id]);
    await c.query(`update public.ordering_orders set status = 'CONFIRMED', version = 2, display_number = $2, total_krw = 20000 ${closed ? ", closed_at = now()" : ""} where id = $1`, [id, n]);
    orderIds.push(id);
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
  if (method === "POST") Object.assign(headers, { "idempotency-key": "s-1", "content-type": "application/json" });
  return app({ method, path: `/v1/tenants/${T}/order-settlements`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /order-settlements", () => {
  it("직원도 종결되지 않은 확정 주문을 최신순으로 읽고, 필터·페이지·쿼리 검증이 동작한다", async () => {
    const list = await call("GET", STAFF);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i: { orderId: string }) => i.orderId)).toEqual([orderIds[1], orderIds[0]]);
    expect(list.body.data.items[0]).toEqual({
      orderId: orderIds[1], displayNumber: 2, totalKrw: "20000", confirmedKrw: "0", pendingKrw: "0", balanceKrw: "20000", refundRequiredKrw: "0",
      orderedQuantity: 2, deliveredQuantity: 0, remainingQuantity: 2,
    });
    expect((await call("GET", OWNER, "includeClosed=true")).body.data.items).toHaveLength(3);
    expect((await call("GET", OWNER, "includeClosed=false")).body.data.items).toHaveLength(2);
    expect((await call("GET", OWNER, "unpaid=true&undelivered=true")).body.data.items).toHaveLength(2);
    const first = await call("GET", OWNER, "limit=1");
    expect((await call("GET", OWNER, `limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)).body.data.items.map((i: { orderId: string }) => i.orderId)).toEqual([orderIds[0]]);
    for (const query of ["unpaid=yes", "undelivered=1", "includeClosed=TRUE", "limit=0", "limit=x", "cursor=%25%25", "x=1"]) expect((await call("GET", OWNER, query)).status, query).toBe(400);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", sub)).status, sub).toBe(403);
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", OWNER)).status).toBe(405);
  });
});
