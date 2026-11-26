import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /notification-targets (O-08 안내 대기 큐): 활성 멤버(Owner·직원) 읽기 전용 */
const SECRET = "queue-secret-0123456789abcdef0123456789";
const T = "aaaaaaaa-0000-4000-8000-0000000000f5";
const OWNER = "11111111-0000-4000-8000-0000000000f5";
const STAFF = "11111111-0000-4000-8000-0000000000f6";
const EX_STAFF = "11111111-0000-4000-8000-0000000000f7";
const STRANGER = "99999999-0000-4000-8000-0000000000f5";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
const targetIds: string[] = [];
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  const order = (await c.query(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ($1, 'CONFIRMED', 7, 1000) returning id`, [T])).rows[0].id as string;
  for (const at of ["2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z"]) {
    targetIds.push((await c.query(`insert into public.ordering_notification_targets (tenant_id, order_id, mode, lines, secured_total, created_by, created_at) values ($1, $2, 'FULL', '[]'::jsonb, 1, 'u', $3) returning id`, [T, order, at])).rows[0].id as string);
  }
  await c.query(`insert into public.ordering_notification_attempts (tenant_id, target_id, channel, message_snapshot, attempted_by, attempted_at) values ($1, $2, 'PHONE', '문구', 'u', now())`, [T, targetIds[0]]);
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
  if (method === "POST") Object.assign(headers, { "idempotency-key": "q-1", "content-type": "application/json" });
  return app({ method, path: `/v1/tenants/${T}/notification-targets`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /notification-targets", () => {
  it("직원도 큐를 최신순으로 읽고(상태·주문 표시번호 포함), status 필터와 쿼리 검증이 동작한다", async () => {
    const all = await call("GET", STAFF);
    expect(all.status).toBe(200);
    expect(all.body.data.items.map((i: { id: string; status: string }) => [i.id, i.status])).toEqual([[targetIds[1], "PENDING"], [targetIds[0], "ATTEMPTED"]]);
    expect(all.body.data.items[0]).toMatchObject({ orderDisplayNumber: 7, mode: "FULL", securedTotal: 1 });
    expect((await call("GET", OWNER, "status=ATTEMPTED")).body.data.items.map((i: { id: string }) => i.id)).toEqual([targetIds[0]]);
    const first = await call("GET", OWNER, "limit=1");
    expect(first.body.data.nextCursor).toBeDefined();
    expect((await call("GET", OWNER, `limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)).body.data.items.map((i: { id: string }) => i.id)).toEqual([targetIds[0]]);
    for (const query of ["status=DONE", "limit=0", "limit=x", "cursor=%25%25", "x=1"]) expect((await call("GET", OWNER, query)).status, query).toBe(400);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", sub)).status, sub).toBe(403);
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("POST", OWNER)).status).toBe(405);
  });
});
