import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /exceptions (O-01-01 예외 업무 큐): 활성 멤버(Owner·직원) 읽기 전용. 내용 검증은 pgExceptionQueue·responseContract가 한다 */
const SECRET = "exceptions-secret-0123456789abcdef0123";
const T = "aaaaaaaa-0000-4000-8000-0000000000fb";
const OWNER = "11111111-0000-4000-8000-0000000000fb";
const STAFF = "11111111-0000-4000-8000-0000000000fc";
const EX_STAFF = "11111111-0000-4000-8000-0000000000fd";
const STRANGER = "99999999-0000-4000-8000-0000000000fb";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  const order = (await c.query(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ($1, 'CONFIRMED', 5, 9000) returning id`, [T])).rows[0].id as string;
  for (const [n, at] of [[1, "2026-03-01T00:00:00Z"], [2, "2026-03-02T00:00:00Z"]] as const) {
    await c.query(`insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ($1, $2, 'BANK_TRANSFER', 1000, $3, $4, 'u')`, [T, order, `EXT-${n}`, at]);
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
  if (method === "POST") Object.assign(headers, { "idempotency-key": "e-1", "content-type": "application/json" });
  return app({ method, path: `/v1/tenants/${T}/exceptions`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /exceptions", () => {
  it("직원도 예외 큐를 최신순으로 읽고 type 필터·커서·쿼리 검증이 동작한다", async () => {
    const list = await call("GET", STAFF);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i: { type: string; occurredAt: string }) => [i.type, i.occurredAt])).toEqual([
      ["UNCONFIRMED_PAYMENT", "2026-03-02T00:00:00.000Z"], ["UNCONFIRMED_PAYMENT", "2026-03-01T00:00:00.000Z"],
    ]);
    expect(list.body.data.items[0]).toMatchObject({ orderDisplayNumber: 5, amountKrw: "1000", refId: expect.any(String), orderId: expect.any(String) });
    expect((await call("GET", OWNER, "type=REFUND_REQUIRED")).body.data.items).toEqual([]);
    const first = await call("GET", OWNER, "limit=1");
    expect((await call("GET", OWNER, `limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)).body.data.items.map((i: { occurredAt: string }) => i.occurredAt)).toEqual(["2026-03-01T00:00:00.000Z"]);
    for (const query of ["type=ALL", "limit=0", "limit=x", "cursor=%25%25", "x=1"]) expect((await call("GET", OWNER, query)).status, query).toBe(400);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405(종결·삭제 경로가 없다)", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", sub)).status, sub).toBe(403);
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", OWNER)).status).toBe(405);
  });
});
