import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * ST-O04(확정 후 가격/품목 변경)는 DEC-08(고객 동의 방식)이 승인되기 전에는 활성화하지 않는다(사용자 결정, PRD·FRD의 승인 보류 항목).
 * 이 시험은 "안 되게" 막혀 있음을 고정한다: 서버에 변경 경로가 없고, DB도 확정 주문의 품목·가격 변경을 거부한다.
 * DEC-08이 승인되면 이 시험을 의도적으로 바꿔야 한다(우연히 열리는 것을 막는 장치).
 */
const SECRET = "st-o04-secret-0123456789abcdef0123456789";
const T = "aaaaaaaa-0000-4000-8000-00000000000c";
const OWNER = "11111111-0000-4000-8000-00000000000c";
const BOOK = "b0000000-0000-4000-8000-00000000000c";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await c.query(
    `insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '책', '{}', null, 10000, 'MANUAL', '시험', 'seed', now())`,
    [BOOK, T],
  );
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
async function call(method: string, path: string, body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "idempotency-key": `o04-${++seq}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method: method as never, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

describe("ST-O04 확정 후 가격/품목 변경은 막혀 있다 (DEC-08 승인 전)", () => {
  it("서버에는 확정 주문의 품목·가격을 바꾸는 경로가 없고, 시도해도 주문은 그대로다", async () => {
    const book = (await call("POST", "/books", { source: "MANUAL", title: "변경 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" })).body.data;
    const draft = (await call("POST", "/orders", { lines: [{ bookId: book.id, quantity: 2, unitPriceKrw: "10000" }] })).body.data;
    const confirmed = (await call("POST", `/orders/${draft.id}/confirm`, { expectedVersion: 1 })).body.data;
    const lineId = confirmed.lines[0].lineId as string;

    const attempts: [string, string, unknown][] = [
      ["POST", `/orders/${draft.id}/lines`, { bookId: book.id, quantity: 1, unitPriceKrw: "9000" }],
      ["PUT", `/orders/${draft.id}`, { lines: [{ bookId: book.id, quantity: 5, unitPriceKrw: "1" }] }],
      ["PATCH", `/orders/${draft.id}`, { totalKrw: "1" }],
      ["PATCH", `/orders/${draft.id}/lines/${lineId}`, { unitPriceKrw: "1" }],
      ["PUT", `/orders/${draft.id}/lines/${lineId}`, { unitPriceKrw: "1" }],
      ["POST", `/orders/${draft.id}/lines/${lineId}/price`, { unitPriceKrw: "1" }],
      ["POST", `/orders/${draft.id}/price-changes`, { lines: [] }],
      ["POST", `/orders/${draft.id}/changes`, { expectedVersion: confirmed.version }],
      ["POST", `/orders/${draft.id}/amendments`, { expectedVersion: confirmed.version }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, body);
      expect([404, 405], `${method} ${path} → ${res.status}`).toContain(res.status);
    }
    expect((await call("GET", `/orders/${draft.id}`)).body.data).toEqual(confirmed);
  });

  it("라우트 표에 주문 품목·가격을 바꾸는 이름의 경로가 없다 (수량 감소는 취소 적용으로만)", () => {
    const suspicious = app.routes.filter((r) => /\/orders\/\{orderId\}(\/lines)?\/?(\{lineId\})?\/?(price|prices|price-changes?|changes?|amendments?|items?|lines|edit|update)?$/.test(r.template) && r.method !== "GET" && !/confirm|hold|resume|discard/.test(r.template));
    expect(suspicious.map((r) => `${r.method} ${r.template}`)).toEqual([]);
  });

  it("DB도 확정 주문에 품목 추가·가격 변경·도서 변경·수량 증가를 거부한다", async () => {
    const c = await db.connect();
    try {
      const book = (await c.query("select id from public.ordering_books where tenant_id = $1 limit 1", [T])).rows[0].id as string;
      const order = (await c.query("select o.id, l.id as line_id from public.ordering_orders o join public.ordering_order_lines l on l.order_id = o.id where o.status = 'CONFIRMED' limit 1")).rows[0];
      const run = (sql: string, params: unknown[]) => sqlState(() => c.query(sql, params));
      expect(await run("insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw) values ($1, $2, 9, $3, 1, 100)", [T, order.id, book])).toBe("P0001");
      expect(await run("update public.ordering_order_lines set unit_price_krw = 1 where id = $1", [order.line_id])).toBe("P0001");
      expect(await run("update public.ordering_order_lines set book_key = 'other' where id = $1", [order.line_id])).toBe("P0001");
      expect(await run("update public.ordering_order_lines set quantity = quantity + 1 where id = $1", [order.line_id])).toBe("P0001");
    } finally {
      await c.end();
    }
  });
});
