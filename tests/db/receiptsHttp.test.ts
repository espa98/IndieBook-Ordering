import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /receipts, GET /receipts/{receiptId}: 활성 멤버(Owner·직원) 읽기 전용 */
const SECRET = "receipts-secret-0123456789abcdef0123456";
const T = "aaaaaaaa-0000-4000-8000-0000000000d5";
const OWNER = "11111111-0000-4000-8000-0000000000d5";
const STAFF = "11111111-0000-4000-8000-0000000000d6";
const EX_STAFF = "11111111-0000-4000-8000-0000000000d7";
const STRANGER = "99999999-0000-4000-8000-0000000000d5";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
let receiptIds: string[] = [];
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  const po = (await c.query(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup', 'SENT', 3) returning id`, [T])).rows[0].id as string;
  const line = (await c.query(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, 'book-x', 10) returning id`, [T, po])).rows[0].id as string;
  for (const [n, at] of [[3, "2026-03-01T00:00:00Z"], [4, "2026-03-02T00:00:00Z"], [2, "2026-03-03T00:00:00Z"]] as const) {
    receiptIds.push((await c.query(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, inspected_by, received_at) values ($1, $2, $3, $4, 'u', $5) returning id`, [T, po, line, n, at])).rows[0].id as string);
  }
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

function call(method: "GET" | "POST", path: string, sub: string | undefined, query = "") {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") headers["idempotency-key"] = "r-1";
  return app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(query), headers, rawBody: method === "POST" ? "{}" : undefined, ...(method === "POST" ? { headers: { ...headers, "content-type": "application/json" } } : {}) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("GET /receipts", () => {
  it("직원도 최신 입고 순 목록을 페이지로 읽고, unallocated 필터와 쿼리 검증이 동작한다", async () => {
    const list = await call("GET", "/receipts", STAFF);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i: { id: string }) => i.id)).toEqual([receiptIds[2], receiptIds[1], receiptIds[0]]);
    expect(list.body.data.items[0]).toMatchObject({ bookKey: "book-x", normalQuantity: 2, unallocatedQuantity: 2, allocatedQuantity: 0 });

    const first = await call("GET", "/receipts", OWNER, "limit=2");
    expect(first.body.data.items).toHaveLength(2);
    const second = await call("GET", "/receipts", OWNER, `limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
    expect(second.body.data.items.map((i: { id: string }) => i.id)).toEqual([receiptIds[0]]);
    expect(second.body.data.nextCursor).toBeUndefined();

    expect((await call("GET", "/receipts", OWNER, "unallocated=true")).body.data.items).toHaveLength(3);
    expect((await call("GET", "/receipts", OWNER, "unallocated=false")).body.data.items).toHaveLength(3);
    for (const query of ["unallocated=yes", "limit=0", "limit=abc", "cursor=%25%25", "purchaseOrderId=nope", "x=1"]) {
      expect((await call("GET", "/receipts", OWNER, query)).status, query).toBe(400);
    }
  });

  it("비멤버·비활성은 403, 인증 없음은 401, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", "/receipts", sub)).status, sub).toBe(403);
    expect((await call("GET", "/receipts", undefined)).status).toBe(401);
    expect((await call("POST", "/receipts", OWNER)).status).toBe(405);
  });
});

describe("GET /receipts/{receiptId}", () => {
  it("상세를 읽고, 없는 입고·UUID가 아닌 ID는 404이며, POST는 405이다", async () => {
    const detail = await call("GET", `/receipts/${receiptIds[1]}`, STAFF);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id: receiptIds[1], normalQuantity: 4, allocations: [], corrections: [], defectResolutions: [], excessDecisions: [] });
    expect((await call("GET", "/receipts/aaaaaaaa-0000-4000-8000-0000000000ff", OWNER)).status).toBe(404);
    expect((await call("GET", "/receipts/not-a-uuid", OWNER)).status).toBe(404);
    expect((await call("GET", `/receipts/${receiptIds[1]}`, STRANGER)).status).toBe(403);
    expect((await call("POST", `/receipts/${receiptIds[1]}`, OWNER)).status).toBe(405);
  });
});
