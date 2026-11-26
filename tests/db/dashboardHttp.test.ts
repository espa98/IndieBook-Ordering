import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /dashboard (O-01): 활성 멤버(Owner·직원) 모두, 서점 범위 서버 집계 */
const SECRET = "dashboard-secret-0123456789abcdef01234";
const T = "aaaaaaaa-0000-4000-8000-0000000000f1";
const OWNER = "11111111-0000-4000-8000-0000000000f1";
const STAFF = "11111111-0000-4000-8000-0000000000f2";
const EX_STAFF = "11111111-0000-4000-8000-0000000000f3";
const STRANGER = "99999999-0000-4000-8000-0000000000f1";

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

let seq = 0;
function call(method: "GET" | "POST", path: string, sub: string | undefined, query = "", body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") headers["idempotency-key"] = `dash-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(query), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /dashboard", () => {
  it("Owner·직원 모두 서버 집계를 보고, 주문을 만들고 보류·폐기하면 숫자가 따라 바뀐다", async () => {
    const empty = await call("GET", "/dashboard", STAFF);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({
      orders: { draft: 0, held: 0, discarded: 0, confirmed: 0 },
      purchaseOrders: { draft: 0, ready: 0, sent: 0, acknowledged: 0 },
      refunds: { required: 0, partial: 0, remainingKrw: "0" },
      dispositions: { openCancellations: 0, pendingQuantity: 0, heldQuantity: 0, dispatchedQuantity: 0 },
      procurement: { notReceivedLines: 0, partiallyReceivedLines: 0, remainingQuantity: 0, delayedLines: 0, delayedQuantity: 0 },
      receipts: { unallocatedReceipts: 0, unallocatedQuantity: 0 },
      payments: { unpaidOrders: 0, balanceKrw: "0", unconfirmedPayments: 0 },
      notifications: { pending: 0, attempted: 0, failed: 0 },
      longUnreceivedWarnings: 0,
    });

    const a = (await call("POST", "/orders", OWNER, "", { lines: [] })).body.data;
    const b = (await call("POST", "/orders", OWNER, "", { lines: [] })).body.data;
    await call("POST", "/orders", OWNER, "", { lines: [] });
    await call("POST", `/orders/${a.id}/hold`, OWNER, "", { expectedVersion: 1, reason: "확인", heldAt: "2026-03-04T06:00:00.000Z" });
    await call("POST", `/orders/${b.id}/discard`, STAFF, "", { expectedVersion: 1, reason: "철회", discardedAt: "2026-03-04T06:00:00.000Z" });

    const after = await call("GET", "/dashboard", OWNER, `since=${new Date(Date.now() - 60_000).toISOString()}`);
    expect(after.body.data.orders).toEqual({ draft: 1, held: 1, discarded: 1, confirmed: 0 });
    expect(after.body.data.receivedSince).toBe(2); // 폐기 제외
  });

  it("비멤버·비활성은 403, 인증 없음은 401, 알 수 없는 쿼리·잘못된 since·thresholdDays는 400, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", "/dashboard", sub)).status, sub).toBe(403);
    expect((await call("GET", "/dashboard", undefined)).status).toBe(401);
    expect((await call("GET", "/dashboard", OWNER, "delayDays=3")).status).toBe(200); // 발주 지연 기준일
    for (const query of ["x=1", "delayDays=0", "delayDays=366", "delayDays=abc", "since=어제", "since=2026-03-04", "since=2999-01-01T00:00:00.000Z", "thresholdDays=0", "thresholdDays=abc"]) {
      expect((await call("GET", "/dashboard", OWNER, query)).status, query).toBe(400);
    }
    expect((await call("POST", "/dashboard", OWNER, "", {})).status).toBe(405);
  });
});
