import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { createHttpServer } from "../../src/http/server";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const SECRET = "http-test-only-secret-0123456789abcdef";
const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
let server: Server;
let base: string;
const logged: unknown[] = [];

beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values
       ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false), ($5, $6, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, EX_STAFF_A, T_B, OWNER_B],
  );
  for (let n = 1; n <= 12; n++) {
    await c.query(
      `insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at)
       values ($1, $2, $3, 10000, 'MANUAL', '시험', 'seed', now())`,
      [BOOK(n), T_A, `책 ${n}`],
    );
  }
  await c.end();
  const app = createApp({
    pool: db.pool(),
    jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" },
    logError: (error) => void logged.push(error),
  });
  server = createHttpServer(app, { maxBodyBytes: 64 * 1024 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);
afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await db?.stop();
}, 60_000);

const nowSec = () => Math.floor(Date.now() / 1000);
const token = (sub: string, extra: Record<string, unknown> = {}) =>
  signHs256({ sub, aud: "authenticated", role: "authenticated", exp: nowSec() + 3600, iat: nowSec(), ...extra }, SECRET, { kid: "k1" });
let seq = 0;
const idem = () => `http-${++seq}`;

type Call = { method?: string; sub?: string | null; headers?: Record<string, string>; body?: unknown; rawBody?: string; key?: string | null };
async function call(path: string, options: Call = {}) {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.sub !== null) headers.authorization ??= `Bearer ${token(options.sub ?? OWNER_A)}`;
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  if (hasBody) headers["content-type"] ??= "application/json";
  if (method === "POST" && options.key !== null) headers["idempotency-key"] ??= options.key ?? idem();
  const response = await fetch(base + path, {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json, text };
}
const orders = (tenant = T_A) => `/v1/tenants/${tenant}/orders`;
const seedStock = async (book: number, quantity: number) => {
  const c = await db.connect();
  await c.query(
    `insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', $3, '초기 재고', 'seed', now())`,
    [T_A, BOOK(book), quantity],
  );
  await c.end();
};
const lines = (book = 1, quantity = 2) => [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }];
async function confirmedOrder(book: number, quantity: number) {
  const created = await call(orders(), { method: "POST", body: { lines: lines(book, quantity) } });
  const confirmed = await call(`${orders()}/${created.json.data.id}/confirm`, { method: "POST", body: { expectedVersion: 1 } });
  return { orderId: confirmed.json.data.id as string, lineId: confirmed.json.data.lines[0].lineId as string, total: confirmed.json.data.totalKrw as string };
}

describe("HTTP 서버: 인증 (T2)", () => {
  it("토큰이 없거나 위조·만료·aud 불일치이면 401이고, 존재하는 경로·없는 경로 모두 같다 (경로 탐색 방지)", async () => {
    // 서명의 첫 문자(6비트가 모두 의미 있다)를 바꿔 항상 다른 서명이 되게 한다. 마지막 문자는 하위 비트가 쓰이지 않아 같은 서명이 될 수 있다
    const [header, payload, signature] = token(OWNER_A).split(".");
    const forged = `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    const cases = [
      { sub: null },
      { sub: null, headers: { authorization: "Bearer garbage" } },
      { sub: null, headers: { authorization: `Bearer ${forged}` } },
      { sub: null, headers: { authorization: `Bearer ${token(OWNER_A, { exp: nowSec() - 600 })}` } },
      { sub: null, headers: { authorization: `Bearer ${token(OWNER_A, { aud: "anon" })}` } },
      { sub: null, headers: { authorization: `Basic ${Buffer.from("a:b").toString("base64")}` } },
    ];
    for (const c of cases) {
      for (const path of [orders(), "/v1/no/such/route"]) {
        const r = await call(path, c);
        expect(r.status, `${path} ${JSON.stringify(c).slice(0, 40)}`).toBe(401);
        expect(r.json).toEqual({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      }
    }
  });

  it("유효한 토큰이어도 서점 멤버가 아니거나 비활성이면 403이다. 경로의 서점 ID는 인증 근거가 아니다", async () => {
    expect((await call(orders(), { sub: STRANGER })).status).toBe(403);
    expect((await call(orders(), { sub: EX_STAFF_A })).status).toBe(403);
    expect((await call(orders(T_B), { sub: OWNER_A })).status).toBe(403); // 다른 서점의 Owner
    expect((await call(orders(T_A), { sub: STAFF_A })).status).toBe(200);
  });

  it("보안 헤더를 붙이고 내부 정보(스택·SQL·키)를 응답에 싣지 않으며 /healthz는 인증 없이 응답한다", async () => {
    const r = await call(orders(), { sub: STRANGER });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.text).not.toMatch(/stack|at .*\.ts|select |insert |SECRET|postgres/i);
    const health = await call("/healthz", { sub: null });
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ status: "ok" });
  });
});

describe("HTTP 서버: 업무 흐름 (주문 → 예약 → 결제 → 인도 → 환급)", () => {
  it("주문 생성·확정·조회·목록과 재고 예약·결제 입력·확인·인도가 HTTP로 이어지고 행위자는 토큰의 사용자로 기록된다", async () => {
    await seedStock(1, 5);
    const created = await call(orders(), { method: "POST", sub: STAFF_A, body: { lines: lines(1, 2) } });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ status: "DRAFT", version: 1 });
    const orderId = created.json.data.id as string;
    const confirmed = await call(`${orders()}/${orderId}/confirm`, { method: "POST", body: { expectedVersion: 1 } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.data).toMatchObject({ status: "CONFIRMED", totalKrw: "30000" });
    const lineId = confirmed.json.data.lines[0].lineId as string;

    const got = await call(`${orders()}/${orderId}`, { sub: STAFF_A });
    expect(got.status).toBe(200);
    expect((await call(`${orders()}?status=CONFIRMED&limit=100`)).json.data.items.map((i: any) => i.id)).toContain(orderId);

    const reservation = await call(`${orders()}/${orderId}/lines/${lineId}/stock-reservations`, { method: "POST", sub: STAFF_A, body: { quantity: 2, reservedAt: "2026-03-04T06:40:00.000Z" } });
    expect(reservation.status).toBe(201);
    expect(reservation.json.data).toMatchObject({ quantity: 2, reservedBy: STAFF_A });

    const payment = await call(`${orders()}/${orderId}/payments`, { method: "POST", sub: STAFF_A, body: { method: "BANK_TRANSFER", amountKrw: "30000", externalReference: `HTTP-${seq}`, paidAt: "2026-03-04T06:00:00.000Z" } });
    expect(payment.status).toBe(201);
    expect(payment.json.data.recordedBy).toBe(STAFF_A);
    const confirmation = await call(`/v1/tenants/${T_A}/payments/${payment.json.data.id}/confirmation`, { method: "POST", sub: STAFF_A, body: { evidence: "입금 내역 확인", confirmedAt: "2026-03-04T06:30:00.000Z" } });
    expect(confirmation.status).toBe(201);

    const fulfillment = await call(`${orders()}/${orderId}/fulfillments`, {
      method: "POST",
      sub: STAFF_A,
      body: { orderLineId: lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.json.data.id, quantity: 2 }], receivedAt: "2026-03-04T06:50:00.000Z" },
    });
    expect(fulfillment.status).toBe(201);
    expect(fulfillment.json.data).toMatchObject({ quantity: 2, amountKrw: "30000", receivedBy: STAFF_A });
  });

  it("환급: Staff가 요청하고 Owner만 승인하며(Staff 승인은 403), 승인하면 환급 원장이 기록된다", async () => {
    const o = await confirmedOrder(2, 2); // 30,000원
    const pay = await call(`${orders()}/${o.orderId}/payments`, { method: "POST", sub: STAFF_A, body: { method: "CARD", amountKrw: "35000", externalReference: `HTTP-REF-${++seq}`, paidAt: "2026-03-04T06:00:00.000Z" } });
    await call(`/v1/tenants/${T_A}/payments/${pay.json.data.id}/confirmation`, { method: "POST", sub: STAFF_A, body: { evidence: "카드 승인 내역", confirmedAt: "2026-03-04T06:30:00.000Z" } });
    const task = await call(`${orders()}/${o.orderId}/refund-tasks`, { method: "POST", sub: OWNER_A, body: { openedAt: "2026-03-04T06:40:00.000Z" } });
    expect(task.status).toBe(201);
    expect(task.json.data.requiredKrw).toBe("5000");
    const request = await call(`/v1/tenants/${T_A}/refund-tasks/${task.json.data.id}/refund-requests`, {
      method: "POST",
      sub: STAFF_A,
      body: { paymentId: pay.json.data.id, amountKrw: "3000", evidence: "카드사 부분 취소 승인 내역", requestedAt: "2026-03-04T06:48:00.000Z" },
    });
    expect(request.status).toBe(201);
    const decisionPath = `/v1/tenants/${T_A}/refund-requests/${request.json.data.id}/decision`;

    expect((await call(decisionPath, { method: "POST", sub: STAFF_A, body: { decision: "APPROVED", decidedAt: "2026-03-04T06:52:00.000Z" } })).status).toBe(403);
    const approved = await call(decisionPath, { method: "POST", sub: OWNER_A, body: { decision: "APPROVED", decidedAt: "2026-03-04T06:52:00.000Z" } });
    expect(approved.status).toBe(200);
    expect(approved.json.data.refund).toMatchObject({ amountKrw: "3000", confirmedBy: OWNER_A });
    expect((await call(decisionPath, { method: "POST", sub: OWNER_A, body: { decision: "REJECTED", decidedAt: "2026-03-04T06:53:00.000Z" } })).status).toBe(422);
  });

  it("환급 시도: Staff가 UNKNOWN을 기록하면 한도가 예약되고, 해소하면 풀리며, 행위자 위조는 400이다", async () => {
    const o = await confirmedOrder(2, 2);
    const pay = await call(`${orders()}/${o.orderId}/payments`, { method: "POST", sub: STAFF_A, body: { method: "CARD", amountKrw: "35000", externalReference: `HTTP-REF-${++seq}`, paidAt: "2026-03-04T06:00:00.000Z" } });
    await call(`/v1/tenants/${T_A}/payments/${pay.json.data.id}/confirmation`, { method: "POST", sub: STAFF_A, body: { evidence: "카드 승인 내역", confirmedAt: "2026-03-04T06:30:00.000Z" } });
    const task = await call(`${orders()}/${o.orderId}/refund-tasks`, { method: "POST", sub: OWNER_A, body: { openedAt: "2026-03-04T06:40:00.000Z" } });
    const attempts = `/v1/tenants/${T_A}/refund-tasks/${task.json.data.id}/refund-attempts`;
    const body = { paymentId: pay.json.data.id, amountKrw: "3000", result: "UNKNOWN", reason: "카드사 응답 시간 초과", reportedAt: "2026-03-04T06:45:00.000Z" };
    expect((await call(attempts, { method: "POST", sub: STAFF_A, body: { ...body, reportedBy: OWNER_A } })).status).toBe(400);
    const reported = await call(attempts, { method: "POST", sub: STAFF_A, body });
    expect(reported.status).toBe(201);
    expect(reported.json.data).toMatchObject({ result: "UNKNOWN", amountKrw: "3000", reportedBy: STAFF_A });

    const requestPath = `/v1/tenants/${T_A}/refund-tasks/${task.json.data.id}/refund-requests`;
    const requestBody = { paymentId: pay.json.data.id, amountKrw: "3000", evidence: "카드사 부분 취소 승인 내역", requestedAt: "2026-03-04T06:48:00.000Z" };
    expect((await call(requestPath, { method: "POST", sub: STAFF_A, body: requestBody })).status).toBe(422); // 예약 중

    const resolutionPath = `/v1/tenants/${T_A}/refund-attempts/${reported.json.data.id}/resolution`;
    expect((await call(resolutionPath, { method: "POST", sub: OWNER_A, body: { outcome: "MAYBE", evidence: "조회", resolvedAt: "2026-03-04T06:50:00.000Z" } })).status).toBe(400);
    const resolved = await call(resolutionPath, { method: "POST", sub: STAFF_A, body: { outcome: "FAILED", evidence: "카드사 조회: 취소 실패", resolvedAt: "2026-03-04T06:50:00.000Z" } });
    expect(resolved.status).toBe(201);
    expect(resolved.json.data).toMatchObject({ outcome: "FAILED", resolvedBy: STAFF_A });
    expect((await call(resolutionPath, { method: "POST", sub: STAFF_A, body: { outcome: "FAILED", evidence: "again", resolvedAt: "2026-03-04T06:51:00.000Z" } })).status).toBe(422);
    expect((await call(requestPath, { method: "POST", sub: STAFF_A, body: requestBody })).status).toBe(201);
  });

  it("취소 요청이 HTTP로 접수되고 다른 서점·없는 리소스 ID는 같은 404이다", async () => {
    await seedStock(3, 2);
    const o = await confirmedOrder(3, 2);
    const cancel = await call(`${orders()}/${o.orderId}/cancellation-requests`, {
      method: "POST",
      sub: STAFF_A,
      body: { orderLineId: o.lineId, quantity: 1, reason: "고객 요청", expectedVersion: 2, requestedAt: "2026-03-04T06:45:00.000Z" },
    });
    expect(cancel.status).toBe(201);
    const missing = await call(`${orders()}/0a000000-0000-4000-8000-00000000ffff`, { sub: OWNER_A });
    const crossTenant = await call(`${orders(T_B)}/${o.orderId}`, { sub: OWNER_B });
    expect(missing.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.json).toEqual(missing.json); // 존재 여부가 드러나지 않는다
  });
});

describe("HTTP 서버: 취소 결정·적용과 종결 요청", () => {
  it("취소 요청을 Owner만 승인·적용하고(Staff는 403) 적용하면 주문이 줄며, 종결 요청은 Staff도 할 수 있다", async () => {
    await seedStock(10, 2);
    const o = await confirmedOrder(10, 2);
    const cancel = await call(`${orders()}/${o.orderId}/cancellation-requests`, {
      method: "POST",
      sub: STAFF_A,
      body: { orderLineId: o.lineId, quantity: 1, reason: "고객 요청", expectedVersion: 2, requestedAt: "2026-03-04T06:45:00.000Z" },
    });
    const requestId = cancel.json.data.id as string;
    const decisionPath = `/v1/tenants/${T_A}/order-cancellation-requests/${requestId}/decision`;

    expect((await call(decisionPath, { method: "POST", sub: STAFF_A, body: { decision: "APPROVED", decidedAt: "2026-03-04T06:47:00.000Z" } })).status).toBe(403);
    const approved = await call(decisionPath, { method: "POST", sub: OWNER_A, body: { decision: "APPROVED", decidedAt: "2026-03-04T06:47:00.000Z" } });
    expect(approved.status).toBe(200);
    expect(approved.json.data).toMatchObject({ kind: "APPROVED", decidedBy: OWNER_A });

    const applyPath = `/v1/tenants/${T_A}/order-cancellation-requests/${requestId}/application`;
    const applyBody = { appliedAt: "2026-03-04T06:49:00.000Z" };
    expect((await call(applyPath, { method: "POST", sub: STAFF_A, body: applyBody })).status).toBe(403);
    const applied = await call(applyPath, { method: "POST", sub: OWNER_A, body: applyBody });
    expect(applied.status).toBe(201);
    expect(applied.json.data).toMatchObject({ kind: "APPLIED" });
    expect((await call(`${orders()}/${o.orderId}`, { sub: OWNER_A })).json.data).toMatchObject({ version: 3, totalKrw: "15000" });

    const closure = await call(`${orders()}/${o.orderId}/closure-requests`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 3, requestedAt: "2026-03-04T06:58:00.000Z" } });
    expect(closure.status).toBe(201);
    expect(closure.json.data).toMatchObject({ orderId: o.orderId, requestedBy: STAFF_A });
    // 종결 실행은 서버만 한다: 사용자 API로는 열지 않는다
    expect((await call(`/v1/tenants/${T_A}/order-closure-requests/${closure.json.data.id}/execution`, { method: "POST", sub: OWNER_A, body: {} })).status).toBe(404);
  });
});

describe("HTTP 서버: 입고·배분 (발주 → 입고 → 배분 → 인도)", () => {
  it("검수 입고, 고객별 배분, 배분 해제, 배분 물량 인도가 HTTP로 이어지고 검수자·배분자는 토큰의 사용자로 기록된다", async () => {
    const o = await confirmedOrder(9, 2);
    const c = await db.connect();
    const po = (await c.query(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T_A])).rows[0].id as string;
    const poLine = (await c.query(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, 2) returning id`, [T_A, po, BOOK(9)])).rows[0].id as string;
    await c.query(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, 2)`, [T_A, poLine, o.orderId, o.lineId]);
    await c.end();

    const receipt = await call(`/v1/tenants/${T_A}/purchase-orders/${po}/receipts`, {
      method: "POST",
      sub: STAFF_A,
      body: { poLineId: poLine, normalQuantity: 2, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z" },
    });
    expect(receipt.status).toBe(201);
    expect(receipt.json.data).toMatchObject({ normalQuantity: 2, inspectedBy: STAFF_A });

    const allocation = await call(`/v1/tenants/${T_A}/receipts/${receipt.json.data.id}/allocations`, {
      method: "POST",
      sub: STAFF_A,
      body: { orderId: o.orderId, orderLineId: o.lineId, quantity: 2, allocatedAt: "2026-03-04T06:40:00.000Z" },
    });
    expect(allocation.status).toBe(201);
    expect(allocation.json.data).toMatchObject({ quantity: 2, allocatedBy: STAFF_A });
    const allocationId = allocation.json.data.id as string;

    const release = await call(`/v1/tenants/${T_A}/allocations/${allocationId}/releases`, { method: "POST", sub: STAFF_A, body: { quantity: 1, reason: "고객이 1권 변경", releasedAt: "2026-03-04T06:50:00.000Z" } });
    expect(release.status).toBe(201);
    expect(release.json.data).toMatchObject({ quantity: 1, releasedBy: STAFF_A });

    const pay = await call(`${orders()}/${o.orderId}/payments`, { method: "POST", sub: STAFF_A, body: { method: "CARD", amountKrw: "15000", externalReference: `HTTP-RCV-${++seq}`, paidAt: "2026-03-04T06:00:00.000Z" } });
    await call(`/v1/tenants/${T_A}/payments/${pay.json.data.id}/confirmation`, { method: "POST", sub: STAFF_A, body: { evidence: "카드 승인 내역", confirmedAt: "2026-03-04T06:30:00.000Z" } });
    const fulfillment = await call(`${orders()}/${o.orderId}/fulfillments`, {
      method: "POST",
      sub: STAFF_A,
      body: { orderLineId: o.lineId, sources: [{ kind: "RECEIPT_ALLOCATION", sourceId: allocationId, quantity: 1 }], receivedAt: "2026-03-04T06:55:00.000Z" },
    });
    expect(fulfillment.status).toBe(201);
    expect(fulfillment.json.data).toMatchObject({ quantity: 1, amountKrw: "15000" });
    // 남은 배분이 없으니 더 인도할 수 없다
    const again = await call(`${orders()}/${o.orderId}/fulfillments`, {
      method: "POST",
      sub: STAFF_A,
      body: { orderLineId: o.lineId, sources: [{ kind: "RECEIPT_ALLOCATION", sourceId: allocationId, quantity: 1 }], receivedAt: "2026-03-04T06:56:00.000Z" },
    });
    expect(again.status).toBe(422);
    // 행위자 필드를 보내는 위조 시도는 400이다
    const forged = await call(`/v1/tenants/${T_A}/receipts/${receipt.json.data.id}/allocations`, { method: "POST", sub: STAFF_A, body: { orderId: o.orderId, orderLineId: o.lineId, quantity: 1, allocatedAt: "2026-03-04T06:40:00.000Z", allocatedBy: OWNER_A } });
    expect(forged.status).toBe(400);
    // 비멤버는 403
    expect((await call(`/v1/tenants/${T_A}/purchase-orders/${po}/receipts`, { method: "POST", sub: STRANGER, body: { poLineId: poLine, normalQuantity: 1, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z" } })).status).toBe(403);
  });
});

describe("HTTP 서버: 취소 물량 처분 (재고 편입·반품 요청)", () => {
  it("취소로 풀린 입고 배분 물량을 Owner만 재고로 편입하거나 반품 요청하고(Staff 403), 같은 물량은 한 번만 처분된다", async () => {
    await seedStock(12, 1);
    const o = await confirmedOrder(12, 2);
    const c = await db.connect();
    const po = (await c.query(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T_A])).rows[0].id as string;
    const poLine = (await c.query(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, 2) returning id`, [T_A, po, BOOK(12)])).rows[0].id as string;
    await c.query(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, 2)`, [T_A, poLine, o.orderId, o.lineId]);
    const receipt = await call(`/v1/tenants/${T_A}/purchase-orders/${po}/receipts`, { method: "POST", sub: STAFF_A, body: { poLineId: poLine, normalQuantity: 2, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z" } });
    const allocation = await call(`/v1/tenants/${T_A}/receipts/${receipt.json.data.id}/allocations`, { method: "POST", sub: STAFF_A, body: { orderId: o.orderId, orderLineId: o.lineId, quantity: 2, allocatedAt: "2026-03-04T06:40:00.000Z" } });
    const cancel = await call(`${orders()}/${o.orderId}/cancellation-requests`, { method: "POST", sub: STAFF_A, body: { orderLineId: o.lineId, quantity: 2, reason: "고객 요청", expectedVersion: 2, requestedAt: "2026-03-04T06:45:00.000Z" } });
    const base = `/v1/tenants/${T_A}/order-cancellation-requests/${cancel.json.data.id}`;
    await call(`${base}/decision`, { method: "POST", sub: OWNER_A, body: { decision: "APPROVED", decidedAt: "2026-03-04T06:47:00.000Z" } });
    await call(`${base}/application`, { method: "POST", sub: OWNER_A, body: { appliedAt: "2026-03-04T06:49:00.000Z" } });
    const cancellationId = (await c.query("select id from public.ordering_allocation_cancellations where allocation_id = $1", [allocation.json.data.id])).rows[0].id as string;
    await c.end();

    const intakePath = `/v1/tenants/${T_A}/allocation-cancellations/${cancellationId}/stock-intakes`;
    const intakeBody = { quantity: 1, actedAt: "2026-03-04T06:55:00.000Z" };
    expect((await call(intakePath, { method: "POST", sub: STAFF_A, body: intakeBody })).status).toBe(403);
    const intaken = await call(intakePath, { method: "POST", sub: OWNER_A, body: intakeBody });
    expect(intaken.status).toBe(201);
    expect(intaken.json.data.intake).toMatchObject({ quantity: 1, actedBy: OWNER_A });

    const returnPath = `/v1/tenants/${T_A}/allocation-cancellations/${cancellationId}/return-requests`;
    const returnBody = { quantity: 1, requestedAt: "2026-03-04T06:56:00.000Z" };
    expect((await call(returnPath, { method: "POST", sub: STAFF_A, body: returnBody })).status).toBe(403);
    const requested = await call(returnPath, { method: "POST", sub: OWNER_A, body: returnBody });
    expect(requested.status).toBe(201);
    expect(requested.json.data).toMatchObject({ quantity: 1, supplierCode: "sup-a", requestedBy: OWNER_A });
    expect((await call(returnPath, { method: "POST", sub: OWNER_A, body: returnBody })).status).toBe(422); // 처분 대기가 없다

    // 반품 후속은 Staff도 기록한다: 회신 → 출고 → 예외 → 해소, 행위자는 토큰의 사용자
    const returns = `/v1/tenants/${T_A}/return-requests/${requested.json.data.id}`;
    const replied = await call(`${returns}/replies`, { method: "POST", sub: STAFF_A, body: { acceptedQuantity: 1, rejectedQuantity: 0, evidence: "공급처 회신 메일", repliedAt: "2026-03-04T07:00:00.000Z" } });
    expect(replied.status).toBe(201);
    expect(replied.json.data).toMatchObject({ acceptedQuantity: 1, repliedBy: STAFF_A });
    const dispatched = await call(`${returns}/dispatches`, { method: "POST", sub: STAFF_A, body: { quantity: 1, dispatchedAt: "2026-03-04T07:10:00.000Z", referenceNumber: "TRK-1" } });
    expect(dispatched.status).toBe(201);
    const excepted = await call(`${returns}/exceptions`, { method: "POST", sub: STAFF_A, body: { quantity: 1, kind: "LOST", evidence: "택배사 분실 확인서", reportedAt: "2026-03-04T07:30:00.000Z" } });
    expect(excepted.status).toBe(201);
    const completionBody = { quantity: 1, evidence: "공급처 수령 확인서", confirmedAt: "2026-03-04T07:20:00.000Z" };
    expect((await call(`${returns}/completions`, { method: "POST", sub: STAFF_A, body: completionBody })).status).toBe(422); // 신고된 수량은 완료할 수 없다
    expect((await call(`${returns}/completions`, { method: "POST", sub: STAFF_A, body: { ...completionBody, confirmedBy: OWNER_A } })).status).toBe(400); // 행위자 위조
    const resolved = await call(`/v1/tenants/${T_A}/return-exceptions/${excepted.json.data.id}/resolutions`, { method: "POST", sub: STAFF_A, body: { outcome: "RETURNED", quantity: 1, evidence: "공급처 최종 확인", resolvedAt: "2026-03-04T07:40:00.000Z" } });
    expect(resolved.status).toBe(201);
    expect(resolved.json.data).toMatchObject({ outcome: "RETURNED", resolvedBy: STAFF_A });
    expect((await call(`${returns}/renegotiations`, { method: "POST", sub: STAFF_A, body: { quantity: 1, retryReason: "재협의", requestedAt: "2026-03-04T07:50:00.000Z" } })).status).toBe(422); // 거절된 수량이 없다
  });
});

describe("HTTP 서버: 발주 (생성 → 전달 준비 → 전달 기록 → 공급처 회신 → 입고)", () => {
  it("배정으로 발주를 만들고 전달·회신·입고까지 HTTP로 이어지며 입력 오류·낡은 version·비멤버는 거부된다", async () => {
    const o = await confirmedOrder(11, 2);
    const c = await db.connect();
    await c.query(`insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel, version) values ($1, 'sup-http', true, 'HTTP 공급처', 'EMAIL', 1) on conflict do nothing`, [T_A]);
    const allocationId = (await c.query(`insert into public.ordering_sourcing_allocations (tenant_id, order_id, order_line_id, supplier_code, quantity) values ($1, $2, $3, 'sup-http', 2) returning id`, [T_A, o.orderId, o.lineId])).rows[0].id as string;
    await c.end();
    const pos = `/v1/tenants/${T_A}/purchase-orders`;

    expect((await call(pos, { method: "POST", sub: STRANGER, body: { supplierCode: "sup-http", allocationIds: [allocationId] } })).status).toBe(403);
    expect((await call(pos, { method: "POST", sub: STAFF_A, body: { supplierCode: "sup-http", allocationIds: [] } })).status).toBe(400);
    const created = await call(pos, { method: "POST", sub: STAFF_A, body: { supplierCode: "sup-http", allocationIds: [allocationId] } });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ status: "DRAFT", version: 1 });
    const poId = created.json.data.id as string;
    const poLineId = created.json.data.lines[0].poLineId as string;
    expect((await call(pos, { method: "POST", sub: STAFF_A, body: { supplierCode: "sup-http", allocationIds: [allocationId] } })).status).toBe(422); // 이미 연결된 배정

    expect((await call(`${pos}/${poId}/ready`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 9 } })).status).toBe(409);
    const readied = await call(`${pos}/${poId}/ready`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 1 } });
    expect(readied.status).toBe(200);
    expect(readied.json.data).toMatchObject({ status: "READY", version: 2 });
    const delivered = await call(`${pos}/${poId}/delivery`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z", referenceNumber: "MAIL-9" } });
    expect(delivered.status).toBe(200);
    expect(delivered.json.data).toMatchObject({ status: "SENT", version: 3 });
    expect(delivered.json.data.delivery).toMatchObject({ deliveredBy: STAFF_A });
    expect((await call(`${pos}/${poId}/delivery`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z", deliveredBy: OWNER_A } })).status).toBe(400); // 행위자 위조

    const reply = await call(`${pos}/${poId}/supplier-replies`, { method: "POST", sub: STAFF_A, body: { poLineId, kind: "CONFIRM", quantity: 2, evidence: "공급처 확정 메일", repliedAt: "2026-03-04T06:20:00.000Z" } });
    expect(reply.status).toBe(201);
    expect(reply.json.data).toMatchObject({ kind: "CONFIRM", quantity: 2 });
    const receipt = await call(`${pos}/${poId}/receipts`, { method: "POST", sub: STAFF_A, body: { poLineId, normalQuantity: 2, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z" } });
    expect(receipt.status).toBe(201);
  });
});

describe("HTTP 서버: 공급처와 조달 배정", () => {
  it("공급처 등록·수정·활성 전환(Owner, 위임 없는 직원은 403)과 조달 배정·해제가 HTTP로 이어지고 행위자는 토큰의 사용자로 기록된다", async () => {
    const sup = `/v1/tenants/${T_A}/suppliers`;
    const registeredAt = "2026-03-04T06:00:00.000Z";
    expect((await call(sup, { method: "POST", sub: STAFF_A, body: { code: "http-s", name: "공급처", orderChannel: "EMAIL", registeredAt } })).status).toBe(403); // 위임 없음
    expect((await call(sup, { method: "POST", sub: OWNER_A, body: { code: "Bad Code", name: "공급처", orderChannel: "EMAIL", registeredAt } })).status).toBe(400);
    const registered = await call(sup, { method: "POST", sub: OWNER_A, body: { code: "http-s", name: "공급처", orderChannel: "EMAIL", registeredAt } });
    expect(registered.status).toBe(201);
    expect(registered.json.data).toMatchObject({ code: "http-s", active: true, version: 1 });
    expect((await call(`${sup}/http-s/updates`, { method: "POST", sub: OWNER_A, body: { expectedVersion: 9, changes: { name: "새 이름" }, reason: "정정", changedAt: "2026-03-04T06:10:00.000Z" } })).status).toBe(409);
    const updated = await call(`${sup}/http-s/updates`, { method: "POST", sub: OWNER_A, body: { expectedVersion: 1, changes: { name: "새 이름" }, reason: "정정", changedAt: "2026-03-04T06:10:00.000Z" } });
    expect(updated.status).toBe(200);
    expect(updated.json.data).toMatchObject({ name: "새 이름", version: 2 });

    const o = await confirmedOrder(5, 2);
    const allocations = `${orders()}/${o.orderId}/lines/${o.lineId}/sourcing-allocations`;
    expect((await call(allocations, { method: "POST", sub: STAFF_A, body: { supplierCode: "http-s", quantity: 3 } })).status).toBe(422); // 품목 수량 초과
    const allocation = await call(allocations, { method: "POST", sub: STAFF_A, body: { supplierCode: "http-s", quantity: 2 } });
    expect(allocation.status).toBe(201);
    expect(allocation.json.data).toMatchObject({ supplierCode: "http-s", quantity: 2, status: "ACTIVE" });
    const po = await call(`/v1/tenants/${T_A}/purchase-orders`, { method: "POST", sub: STAFF_A, body: { supplierCode: "http-s", allocationIds: [allocation.json.data.id] } });
    expect(po.status).toBe(201);
    const releasePath = `/v1/tenants/${T_A}/sourcing-allocations/${allocation.json.data.id}/releases`;
    expect((await call(releasePath, { method: "POST", sub: STAFF_A, body: { reason: "공급처 변경", releasedAt: "2026-03-04T06:30:00.000Z" } })).status).toBe(422); // 미전달 발주에 연결됨
    await call(`/v1/tenants/${T_A}/purchase-orders/${po.json.data.id}/ready`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 1 } });
    await call(`/v1/tenants/${T_A}/purchase-orders/${po.json.data.id}/delivery`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z" } });
    const released = await call(releasePath, { method: "POST", sub: STAFF_A, body: { reason: "공급처 변경", releasedAt: "2026-03-04T06:30:00.000Z" } });
    expect(released.status).toBe(201);
    expect(released.json.data).toMatchObject({ releasedBy: STAFF_A, quantity: 2 });

    // 남은 공급처 의무가 있는 품목의 재조달은 Owner의 중복 위험 승인이 필요하다 (BR-P05)
    const obligation = { purchaseOrderId: po.json.data.id, poLineId: po.json.data.lines[0].poLineId };
    expect((await call(allocations, { method: "POST", sub: STAFF_A, body: { supplierCode: "http-s", quantity: 2 } })).status).toBe(422);
    const approvalBody = { ...obligation, surplusPlan: "STOCK_INTAKE", planNote: "남는 물량은 재고로 편입", approvedAt: "2026-03-04T06:40:00.000Z" };
    const approvals = `${orders()}/${o.orderId}/lines/${o.lineId}/duplicate-risk-approvals`;
    expect((await call(approvals, { method: "POST", sub: STAFF_A, body: approvalBody })).status).toBe(403);
    const approved = await call(approvals, { method: "POST", sub: OWNER_A, body: approvalBody });
    expect(approved.status).toBe(201);
    expect(approved.json.data).toMatchObject({ approvedBy: OWNER_A, surplusPlan: "STOCK_INTAKE" });
    expect((await call(allocations, { method: "POST", sub: STAFF_A, body: { supplierCode: "http-s", quantity: 2 } })).status).toBe(201);

    const off = await call(`${sup}/http-s/activation`, { method: "POST", sub: OWNER_A, body: { active: false, reason: "거래 중단", changedAt: "2026-03-04T06:20:00.000Z" } });
    expect(off.status).toBe(200);
    expect(off.json.data).toMatchObject({ active: false, version: 3 });
    expect((await call(`${sup}/http-s/activation`, { method: "POST", sub: OWNER_A, body: { active: false, reason: "거래 중단", changedAt: "2026-03-04T06:20:00.000Z" } })).status).toBe(422);
  });
});

describe("HTTP 서버: 발주 취소", () => {
  it("전달 전 발주는 바로 취소되고, 전달된 발주는 공급처 취소 요청 → 응답 → 전량 수락 확정으로만 취소된다", async () => {
    const c = await db.connect();
    await c.query(`insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel, version) values ($1, 'sup-cancel', true, '취소 공급처', 'EMAIL', 1) on conflict do nothing`, [T_A]);
    const newPo = async (book: number, quantity: number) => {
      const o = await confirmedOrder(book, quantity);
      const allocationId = (await c.query(`insert into public.ordering_sourcing_allocations (tenant_id, order_id, order_line_id, supplier_code, quantity) values ($1, $2, $3, 'sup-cancel', $4) returning id`, [T_A, o.orderId, o.lineId, quantity])).rows[0].id as string;
      const po = await call(`/v1/tenants/${T_A}/purchase-orders`, { method: "POST", sub: STAFF_A, body: { supplierCode: "sup-cancel", allocationIds: [allocationId] } });
      return { id: po.json.data.id as string, poLineId: po.json.data.lines[0].poLineId as string };
    };
    const pos = `/v1/tenants/${T_A}/purchase-orders`;

    const undelivered = await newPo(6, 1);
    const cancelBody = { expectedVersion: 1, reason: "공급처 변경", cancelledAt: "2026-03-04T06:15:00.000Z" };
    expect((await call(`${pos}/${undelivered.id}/cancellation`, { method: "POST", sub: STAFF_A, body: { ...cancelBody, expectedVersion: 9 } })).status).toBe(409);
    expect((await call(`${pos}/${undelivered.id}/cancellation`, { method: "POST", sub: STAFF_A, body: { ...cancelBody, cancelledBy: OWNER_A } })).status).toBe(400); // 행위자 위조
    const cancelled = await call(`${pos}/${undelivered.id}/cancellation`, { method: "POST", sub: STAFF_A, body: cancelBody });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.data).toMatchObject({ status: "CANCELLED", version: 2, cancelledBy: STAFF_A });

    const sent = await newPo(7, 2);
    await call(`${pos}/${sent.id}/ready`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 1 } });
    await call(`${pos}/${sent.id}/delivery`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z" } });
    expect((await call(`${pos}/${sent.id}/cancellation`, { method: "POST", sub: STAFF_A, body: { ...cancelBody, expectedVersion: 3 } })).status).toBe(422); // 전달된 발주
    const request = await call(`${pos}/${sent.id}/lines/${sent.poLineId}/cancellation-requests`, { method: "POST", sub: STAFF_A, body: { quantity: 2, reason: "고객 취소" } });
    expect(request.status).toBe(201);
    const responsePath = `${pos}/${sent.id}/cancellation-requests/${request.json.data.id}/responses`;
    const responseBody = { acceptedQuantity: 2, rejectedQuantity: 0, evidence: "공급처 취소 회신 메일", repliedAt: "2026-03-04T06:25:00.000Z" };
    expect((await call(responsePath, { method: "POST", sub: STAFF_A, body: { ...responseBody, acceptedQuantity: 3 } })).status).toBe(422); // 요청 2권 초과
    expect((await call(responsePath, { method: "POST", sub: STAFF_A, body: responseBody })).status).toBe(201);
    expect((await call(`${pos}/${sent.id}/cancellation-confirmation`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 9 } })).status).toBe(409);
    const confirmed = await call(`${pos}/${sent.id}/cancellation-confirmation`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 3 } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.data).toMatchObject({ status: "CANCELLED", version: 4 });
    await c.end();
  });
});

describe("HTTP 서버: 입고 후속 (파손 해소·초과 결정·입고 정정)", () => {
  it("파손·오배송 해소(폐기는 Owner만), 초과입고 결정(Owner만), 입고 정정(Owner만)이 HTTP로 이어진다", async () => {
    const c = await db.connect();
    await c.query(`insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel, version) values ($1, 'sup-rcpt', true, '입고 공급처', 'EMAIL', 1) on conflict do nothing`, [T_A]);
    const o = await confirmedOrder(8, 2);
    const allocationId = (await c.query(`insert into public.ordering_sourcing_allocations (tenant_id, order_id, order_line_id, supplier_code, quantity) values ($1, $2, $3, 'sup-rcpt', 2) returning id`, [T_A, o.orderId, o.lineId])).rows[0].id as string;
    await c.end();
    const pos = `/v1/tenants/${T_A}/purchase-orders`;
    const po = await call(pos, { method: "POST", sub: STAFF_A, body: { supplierCode: "sup-rcpt", allocationIds: [allocationId] } });
    const poId = po.json.data.id as string;
    const poLineId = po.json.data.lines[0].poLineId as string;
    await call(`${pos}/${poId}/ready`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 1 } });
    await call(`${pos}/${poId}/delivery`, { method: "POST", sub: STAFF_A, body: { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z" } });
    const receipt = await call(`${pos}/${poId}/receipts`, { method: "POST", sub: STAFF_A, body: { poLineId, normalQuantity: 3, damagedQuantity: 1, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z" } });
    expect(receipt.json.data).toMatchObject({ normalQuantity: 2, excessQuantity: 1, damagedQuantity: 1 });
    const base = `/v1/tenants/${T_A}/receipts/${receipt.json.data.id}`;

    const defect = { kind: "DAMAGED", quantity: 1, outcome: "DISCARDED", evidence: "폐기 확인서", resolvedAt: "2026-03-04T07:00:00.000Z" };
    expect((await call(`${base}/defect-resolutions`, { method: "POST", sub: STAFF_A, body: defect })).status).toBe(403); // 폐기는 Owner만
    const resolved = await call(`${base}/defect-resolutions`, { method: "POST", sub: OWNER_A, body: defect });
    expect(resolved.status).toBe(201);
    expect(resolved.json.data).toMatchObject({ kind: "DAMAGED", resolvedBy: OWNER_A });
    expect((await call(`${base}/defect-resolutions`, { method: "POST", sub: OWNER_A, body: defect })).status).toBe(422); // 기록된 1권을 이미 해소

    const decision = { decision: "APPROVED", quantity: 1, reason: "점주 승인", decidedAt: "2026-03-04T07:10:00.000Z" };
    expect((await call(`${base}/excess-decisions`, { method: "POST", sub: STAFF_A, body: decision })).status).toBe(403);
    const decided = await call(`${base}/excess-decisions`, { method: "POST", sub: OWNER_A, body: decision });
    expect(decided.status).toBe(201);
    expect(decided.json.data).toMatchObject({ decision: "APPROVED", decidedBy: OWNER_A });
    expect((await call(`${base}/excess-decisions`, { method: "POST", sub: OWNER_A, body: { ...decision, decidedBy: STAFF_A } })).status).toBe(400); // 행위자 위조

    const correction = { quantity: 1, reason: "검수 수량 정정", correctedAt: "2026-03-04T07:20:00.000Z" };
    expect((await call(`${base}/corrections`, { method: "POST", sub: STAFF_A, body: correction })).status).toBe(403);
    expect((await call(`${base}/corrections`, { method: "POST", sub: OWNER_A, body: { ...correction, quantity: 3 } })).status).toBe(422); // 정상 2권 초과
    const corrected = await call(`${base}/corrections`, { method: "POST", sub: OWNER_A, body: correction });
    expect(corrected.status).toBe(201);
    expect(corrected.json.data).toMatchObject({ quantity: 1, correctedBy: OWNER_A });
  });
});

describe("HTTP 서버: 배분 취소·재배정", () => {
  it("배분을 다른 고객에게 옮기고(Owner만) 남은 배분을 취소 처분으로 돌리는 것(Owner만)이 HTTP로 이어진다", async () => {
    const first = await confirmedOrder(9, 2);
    const second = await confirmedOrder(9, 2);
    const c = await db.connect();
    const po = (await c.query(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T_A])).rows[0].id as string;
    const poLine = (await c.query(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, 4) returning id`, [T_A, po, BOOK(9)])).rows[0].id as string;
    for (const o of [first, second]) {
      await c.query(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, 2)`, [T_A, poLine, o.orderId, o.lineId]);
    }
    await c.end();
    const receipt = await call(`/v1/tenants/${T_A}/purchase-orders/${po}/receipts`, { method: "POST", sub: STAFF_A, body: { poLineId: poLine, normalQuantity: 4, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z" } });
    const allocation = await call(`/v1/tenants/${T_A}/receipts/${receipt.json.data.id}/allocations`, { method: "POST", sub: STAFF_A, body: { orderId: first.orderId, orderLineId: first.lineId, quantity: 2, allocatedAt: "2026-03-04T06:40:00.000Z" } });
    const base = `/v1/tenants/${T_A}/allocations/${allocation.json.data.id}`;

    const move = { toOrderId: second.orderId, toOrderLineId: second.lineId, quantity: 1, reason: "다른 고객에게 배분", actedAt: "2026-03-04T06:55:00.000Z" };
    expect((await call(`${base}/reallocations`, { method: "POST", sub: STAFF_A, body: move })).status).toBe(403); // 다른 고객으로의 재배분은 Owner만
    const moved = await call(`${base}/reallocations`, { method: "POST", sub: OWNER_A, body: move });
    expect(moved.status).toBe(201);
    expect(moved.json.data.release).toMatchObject({ quantity: 1 });
    expect(moved.json.data.allocation).toMatchObject({ orderId: second.orderId, quantity: 1, allocatedBy: OWNER_A });
    expect((await call(`${base}/reallocations`, { method: "POST", sub: OWNER_A, body: { ...move, quantity: 5 } })).status).toBe(422);

    const cancel = { quantity: 1, reason: "고객 취소", cancelledAt: "2026-03-04T06:50:00.000Z" };
    expect((await call(`${base}/cancellations`, { method: "POST", sub: STAFF_A, body: cancel })).status).toBe(403); // 취소 확정은 Owner만
    expect((await call(`${base}/cancellations`, { method: "POST", sub: OWNER_A, body: { ...cancel, cancelledBy: STAFF_A } })).status).toBe(400); // 행위자 위조
    const cancelled = await call(`${base}/cancellations`, { method: "POST", sub: OWNER_A, body: cancel });
    expect(cancelled.status).toBe(201);
    expect(cancelled.json.data).toMatchObject({ quantity: 1, cancelledBy: OWNER_A });
    expect((await call(`${base}/cancellations`, { method: "POST", sub: OWNER_A, body: cancel })).status).toBe(422); // 잔량 0
  });
});

describe("HTTP 서버: 결제·수령 정정 (Owner 전용)", () => {
  it("확인된 결제의 감액 정정과 수령 정정을 Owner만 할 수 있고(Staff 403), 행위자 위조는 400이며 수량·금액 초과는 422이다", async () => {
    await seedStock(4, 2);
    const o = await confirmedOrder(4, 2);
    const reservation = await call(`${orders()}/${o.orderId}/lines/${o.lineId}/stock-reservations`, { method: "POST", sub: STAFF_A, body: { quantity: 2, reservedAt: "2026-03-04T06:40:00.000Z" } });
    const payment = await call(`${orders()}/${o.orderId}/payments`, { method: "POST", sub: STAFF_A, body: { method: "CARD", amountKrw: "30000", externalReference: `HTTP-COR-${++seq}`, paidAt: "2026-03-04T06:00:00.000Z" } });
    await call(`/v1/tenants/${T_A}/payments/${payment.json.data.id}/confirmation`, { method: "POST", sub: STAFF_A, body: { evidence: "카드 승인 내역", confirmedAt: "2026-03-04T06:30:00.000Z" } });
    const fulfillment = await call(`${orders()}/${o.orderId}/fulfillments`, {
      method: "POST", sub: STAFF_A,
      body: { orderLineId: o.lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.json.data.id, quantity: 2 }], receivedAt: "2026-03-04T06:50:00.000Z" },
    });

    const payBody = { reducedKrw: "10000", reason: "금액 오기록", evidence: "입금 내역 재확인", correctedAt: "2026-03-04T07:00:00.000Z" };
    const payPath = `/v1/tenants/${T_A}/payments/${payment.json.data.id}/corrections`;
    expect((await call(payPath, { method: "POST", sub: STAFF_A, body: payBody })).status).toBe(403);
    expect((await call(payPath, { method: "POST", sub: OWNER_A, body: { ...payBody, correctedBy: STAFF_A } })).status).toBe(400); // 행위자 위조
    expect((await call(payPath, { method: "POST", sub: OWNER_A, body: { ...payBody, reducedKrw: "0" } })).status).toBe(400);
    const corrected = await call(payPath, { method: "POST", sub: OWNER_A, body: payBody });
    expect(corrected.status).toBe(201);
    expect(corrected.json.data).toMatchObject({ reducedKrw: "10000", correctedBy: OWNER_A });
    expect((await call(payPath, { method: "POST", sub: OWNER_A, body: { ...payBody, reducedKrw: "20001" } })).status).toBe(422); // 남은 20,000원 초과

    const fulPath = `${orders()}/${o.orderId}/fulfillments/${fulfillment.json.data.id}/corrections`;
    const fulBody = { quantity: 1, restorations: [{ kind: "STOCK_RESERVATION", sourceId: reservation.json.data.id, quantity: 1 }], reason: "수령 오기록", evidence: "매장 반입 확인", physicalReturnConfirmed: true, correctedAt: "2026-03-04T07:30:00.000Z" };
    expect((await call(fulPath, { method: "POST", sub: STAFF_A, body: fulBody })).status).toBe(403);
    expect((await call(fulPath, { method: "POST", sub: OWNER_A, body: { ...fulBody, physicalReturnConfirmed: false } })).status).toBe(422); // 실물 반입 미확인
    const fixed = await call(fulPath, { method: "POST", sub: OWNER_A, body: fulBody });
    expect(fixed.status).toBe(201);
    expect(fixed.json.data).toMatchObject({ quantity: 1, correctedBy: OWNER_A, fulfillmentId: fulfillment.json.data.id });
    expect((await call(fulPath, { method: "POST", sub: OWNER_A, body: { ...fulBody, quantity: 2, restorations: [{ ...fulBody.restorations[0], quantity: 2 }] } })).status).toBe(422); // 남은 1권 초과
  });
});

describe("HTTP 서버: 재고 운영과 결제 무효", () => {
  it("초기 재고 등록(Owner만), 재고 조정(위임 없는 직원은 403), 예약 해제, 확인 전 결제 무효가 HTTP로 이어진다", async () => {
    const stockBase = `/v1/tenants/${T_A}/books/${BOOK(7)}`;
    const initial = { quantity: 5, actedAt: "2026-03-04T06:00:00.000Z" };
    expect((await call(`${stockBase}/initial-stock`, { method: "POST", sub: STAFF_A, body: initial })).status).toBe(403);
    expect((await call(`${stockBase}/initial-stock`, { method: "POST", sub: OWNER_A, body: { ...initial, actedBy: STAFF_A } })).status).toBe(400); // 행위자 위조
    const registered = await call(`${stockBase}/initial-stock`, { method: "POST", sub: OWNER_A, body: initial });
    expect(registered.status).toBe(201);
    expect(registered.json.data).toMatchObject({ kind: "INITIAL", quantity: 5, actedBy: OWNER_A });
    expect((await call(`${stockBase}/initial-stock`, { method: "POST", sub: OWNER_A, body: initial })).status).toBe(422); // 도서당 한 번

    const adjustment = { direction: "IN", quantity: 2, reason: "실사 정정", actedAt: "2026-03-04T06:10:00.000Z" };
    expect((await call(`${stockBase}/stock-adjustments`, { method: "POST", sub: STAFF_A, body: adjustment })).status).toBe(403); // 재고 조정을 위임받지 않은 직원
    const adjusted = await call(`${stockBase}/stock-adjustments`, { method: "POST", sub: OWNER_A, body: adjustment });
    expect(adjusted.status).toBe(201);
    expect(adjusted.json.data).toMatchObject({ kind: "ADJUST", direction: "IN", quantity: 2 });

    const o = await confirmedOrder(7, 2);
    const reservation = await call(`${orders()}/${o.orderId}/lines/${o.lineId}/stock-reservations`, { method: "POST", sub: STAFF_A, body: { quantity: 2, reservedAt: "2026-03-04T06:40:00.000Z" } });
    const releasePath = `/v1/tenants/${T_A}/stock-reservations/${reservation.json.data.id}/releases`;
    const release = { quantity: 1, reason: "고객 요청", releasedAt: "2026-03-04T06:50:00.000Z" };
    expect((await call(releasePath, { method: "POST", sub: STAFF_A, body: { ...release, quantity: 3 } })).status).toBe(422); // 예약 2권 초과
    const released = await call(releasePath, { method: "POST", sub: STAFF_A, body: release });
    expect(released.status).toBe(201);
    expect(released.json.data).toMatchObject({ quantity: 1, releasedBy: STAFF_A });

    const payment = await call(`${orders()}/${o.orderId}/payments`, { method: "POST", sub: STAFF_A, body: { method: "BANK_TRANSFER", amountKrw: "30000", externalReference: `HTTP-VOID-${++seq}`, paidAt: "2026-03-04T06:00:00.000Z" } });
    const voidPath = `/v1/tenants/${T_A}/payments/${payment.json.data.id}/void`;
    const voided = await call(voidPath, { method: "POST", sub: STAFF_A, body: { reason: "오입력", voidedAt: "2026-03-04T06:20:00.000Z" } });
    expect(voided.status).toBe(201);
    expect(voided.json.data).toMatchObject({ reason: "오입력", voidedBy: STAFF_A });
    expect((await call(voidPath, { method: "POST", sub: STAFF_A, body: { reason: "오입력", voidedAt: "2026-03-04T06:20:00.000Z" } })).status).toBe(422); // 이미 무효
  });
});

describe("HTTP 서버: 직원 초대·철회·비활성화 (Owner 전용)", () => {
  it("Owner만 직원을 초대하고(토큰은 응답에만 한 번) 철회하며, 직원을 비활성화하면 그 직원의 다음 요청이 즉시 403이다", async () => {
    const invitations = `/v1/tenants/${T_A}/staff-invitations`;
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await call(invitations, { method: "POST", sub: STAFF_A, body: { email: "new@shop.test", expiresAt } })).status).toBe(403);
    expect((await call(invitations, { method: "POST", sub: OWNER_A, body: { email: "bad", expiresAt } })).status).toBe(400);
    expect((await call(invitations, { method: "POST", sub: OWNER_A, body: { email: "new@shop.test", expiresAt, invitedBy: STAFF_A } })).status).toBe(400); // 행위자 위조
    const invited = await call(invitations, { method: "POST", sub: OWNER_A, body: { email: "new@shop.test", expiresAt } });
    expect(invited.status).toBe(201);
    expect(invited.json.data.invitation).toMatchObject({ email: "new@shop.test", role: "STAFF", invitedBy: OWNER_A });
    expect(typeof invited.json.data.token).toBe("string");
    expect(JSON.stringify(invited.json.data.invitation)).not.toContain(invited.json.data.token); // 토큰 원문은 초대 객체에 없다
    expect((await call(invitations, { method: "POST", sub: OWNER_A, body: { email: "new@shop.test", expiresAt } })).status).toBe(422); // 중복 초대

    expect((await call(`${invitations}/${invited.json.data.invitation.id}/revocation`, { method: "POST", sub: STAFF_A, body: {} })).status).toBe(403);
    const revoked = await call(`${invitations}/${invited.json.data.invitation.id}/revocation`, { method: "POST", sub: OWNER_A, body: {} });
    expect(revoked.status).toBe(201);
    expect(revoked.json.data).toMatchObject({ kind: "REVOKED", actorId: OWNER_A });

    const STAFF_C = "11111111-0000-4000-8000-0000000000c3";
    const c = await db.connect();
    await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'STAFF', true)`, [T_A, STAFF_C]);
    await c.end();
    expect((await call(orders(), { sub: STAFF_C })).status).toBe(200);
    const statusPath = `/v1/tenants/${T_A}/members/${STAFF_C}/status`;
    expect((await call(statusPath, { method: "POST", sub: STAFF_A, body: { status: "INACTIVE" } })).status).toBe(403);
    const off = await call(statusPath, { method: "POST", sub: OWNER_A, body: { status: "INACTIVE" } });
    expect(off.status).toBe(200);
    expect(off.json.data).toMatchObject({ userId: STAFF_C, from: "ACTIVE", to: "INACTIVE", changedBy: OWNER_A });
    expect((await call(orders(), { sub: STAFF_C })).status).toBe(403); // 비활성화는 즉시 접근을 막는다
    expect((await call(statusPath, { method: "POST", sub: OWNER_A, body: { status: "INACTIVE" } })).status).toBe(422);
    expect((await call(statusPath, { method: "POST", sub: OWNER_A, body: { status: "ACTIVE" } })).status).toBe(200);
    expect((await call(orders(), { sub: STAFF_C })).status).toBe(200);
  });
});

describe("HTTP 서버: 입력 방어", () => {
  it("Idempotency-Key 누락·공백·128자 초과는 400이다", async () => {
    const body = { lines: lines() };
    expect((await call(orders(), { method: "POST", key: null, body })).status).toBe(400);
    expect((await call(orders(), { method: "POST", headers: { "idempotency-key": "   " }, body })).status).toBe(400);
    expect((await call(orders(), { method: "POST", headers: { "idempotency-key": "k".repeat(129) }, body })).status).toBe(400);
    expect((await call(orders(), { method: "POST", headers: { "idempotency-key": "k".repeat(128) }, body })).status).toBe(201);
  });

  it("JSON이 아니거나 객체가 아닌 본문·잘못된 Content-Type은 400·415이고, 본문 상한(64KiB)을 넘으면 413이다", async () => {
    expect((await call(orders(), { method: "POST", rawBody: "{not json" })).status).toBe(400);
    expect((await call(orders(), { method: "POST", rawBody: "[1,2]" })).status).toBe(400);
    expect((await call(orders(), { method: "POST", rawBody: "null" })).status).toBe(400);
    expect((await call(orders(), { method: "POST", rawBody: "{}", headers: { "content-type": "text/plain" } })).status).toBe(415);
    const big = await call(orders(), { method: "POST", rawBody: JSON.stringify({ lines: lines(), pad: "x".repeat(70 * 1024) }) });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("허용되지 않은 필드는 400이다: 행위자·역할·서점을 본문에 실어 보내는 위조 시도도 같다", async () => {
    const o = await confirmedOrder(4, 1);
    const forged = [
      { path: orders(), body: { lines: lines(), tenantId: T_B } },
      { path: orders(), body: { lines: lines(), actorRole: "OWNER" } },
      { path: `${orders()}/${o.orderId}/payments`, body: { method: "CARD", amountKrw: "1000", externalReference: "X", paidAt: "2026-03-04T06:00:00.000Z", recordedBy: OWNER_A } },
      { path: `${orders()}/${o.orderId}/lines/${o.lineId}/stock-reservations`, body: { quantity: 1, reservedAt: "2026-03-04T06:00:00.000Z", reservedBy: OWNER_A } },
      { path: `/v1/tenants/${T_A}/refund-requests/${o.orderId}/decision`, body: { decision: "APPROVED", decidedAt: "2026-03-04T06:00:00.000Z", actorRole: "OWNER" } },
    ];
    for (const f of forged) {
      const r = await call(f.path, { method: "POST", sub: STAFF_A, body: f.body });
      expect(r.status, f.path).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION_ERROR");
      expect(r.text).not.toContain("recordedBy"); // 클라이언트가 보낸 필드 이름은 되돌리지 않는다
    }
  });

  it("경로의 ID가 UUID가 아니면 404, 없는 경로는 404, 허용되지 않은 메서드는 405(Allow 헤더)이다", async () => {
    expect((await call(`${orders()}/not-a-uuid`)).status).toBe(404);
    expect((await call("/v1/tenants/not-a-uuid/orders")).status).toBe(404);
    expect((await call("/v1/tenants/" + T_A + "/nothing")).status).toBe(404);
    const method = await call(orders(), { method: "DELETE" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toContain("GET");
    expect((await call("/healthz", { sub: null, method: "POST", key: null, body: {} })).status).toBe(405);
  });

  it("처리하지 못한 오류는 500으로 고정 문구만 응답하고 내부 오류는 로그 훅으로만 전달한다", async () => {
    const c = await db.connect();
    // 확정 때 카운터 테이블을 못 찾아 DB 오류가 나게 한다. 다른 테스트에 영향이 없도록 끝나면 원래 이름으로 되돌린다
    await c.query("alter table public.ordering_counters rename to ordering_counters_hidden");
    try {
      const created = await call(orders(), { method: "POST", body: { lines: lines(5, 1) } });
      const r = await call(`${orders()}/${created.json.data.id}/confirm`, { method: "POST", body: { expectedVersion: 1 } });
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      await c.query("alter table public.ordering_counters_hidden rename to ordering_counters");
      await c.end();
    }
  });
});

describe("HTTP 서버: 멱등과 실제 동시성 (HTTP 요청)", () => {
  it("같은 Idempotency-Key·같은 본문은 같은 주문(201 두 번), 다른 본문은 409이다", async () => {
    const key = idem();
    const body = { lines: lines(6, 1) };
    const first = await call(orders(), { method: "POST", key, body });
    const retry = await call(orders(), { method: "POST", key, body });
    expect([first.status, retry.status]).toEqual([201, 201]);
    expect(retry.json.data.id).toBe(first.json.data.id);
    const conflict = await call(orders(), { method: "POST", key, body: { lines: lines(6, 2) } });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("같은 키로 동시에 보낸 요청 둘은 같은 주문을 받는다", async () => {
    const key = idem();
    const body = { lines: lines(7, 1) };
    const [a, b] = await Promise.all([call(orders(), { method: "POST", key, body }), call(orders(), { method: "POST", key, body })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.json.data.id).toBe(b.json.data.id);
  });

  it("마지막 3권에 대해 6개 HTTP 요청이 동시에 1권씩 예약하면 정확히 3건만 201이고 나머지는 422이다", async () => {
    await seedStock(8, 3);
    const targets = [];
    for (let i = 0; i < 6; i++) targets.push(await confirmedOrder(8, 1));

    const responses = await Promise.all(
      targets.map((t, i) =>
        call(`${orders()}/${t.orderId}/lines/${t.lineId}/stock-reservations`, { method: "POST", sub: i % 2 ? STAFF_A : OWNER_A, body: { quantity: 1, reservedAt: "2026-03-04T06:40:00.000Z" } }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
    const rejected = responses.filter((r) => r.status !== 201);
    expect(rejected.every((r) => r.status === 422 && r.json.error.code === "BUSINESS_INVARIANT")).toBe(true);
  });
});

describe("HTTP 서버: 도서 등록·수정", () => {
  it("직원도 수기 도서를 등록·수정하고 행위자는 토큰의 사용자로 기록되며, 중복 ISBN은 422, 오래된 버전은 409이다", async () => {
    const books = `/v1/tenants/${T_A}/books`;
    const registeredAt = new Date().toISOString();
    const body = { source: "MANUAL", title: "HTTP 도서", authors: ["저자"], isbn: "9788900001111", listPriceKrw: "9000", reason: "수기 등록", registeredAt };
    expect((await call(books, { method: "POST", sub: "33333333-0000-4000-8000-0000000000ff", body })).status).toBe(403);
    expect((await call(books, { method: "POST", sub: STAFF_A, body: { ...body, registeredBy: OWNER_A } })).status).toBe(400); // 행위자 위조
    const created = await call(books, { method: "POST", sub: STAFF_A, body });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ title: "HTTP 도서", isbn: "9788900001111", version: 1, createdBy: STAFF_A });
    expect((await call(books, { method: "POST", sub: OWNER_A, body })).status).toBe(422); // 중복 ISBN

    const path = `${books}/${created.json.data.id}/updates`;
    const changedAt = new Date().toISOString();
    expect((await call(path, { method: "POST", sub: OWNER_A, body: { expectedVersion: 5, changes: { listPriceKrw: "9500" }, reason: "인상", changedAt } })).status).toBe(409);
    const updated = await call(path, { method: "POST", sub: OWNER_A, body: { expectedVersion: 1, changes: { listPriceKrw: "9500" }, reason: "인상", changedAt } });
    expect(updated.status).toBe(200);
    expect(updated.json.data).toMatchObject({ listPriceKrw: "9500", version: 2 });
  });
});

describe("HTTP 서버: 안내 문구 템플릿 게시", () => {
  it("위임 없는 직원은 403, Owner는 게시하고 버전이 오르며, 허용되지 않은 변수는 400·오래된 버전은 409이다", async () => {
    const path = `/v1/tenants/${T_A}/message-templates`;
    const publishedAt = new Date().toISOString();
    const body = { key: "HTTP_DELAY", body: "{{bookTitle}} 입고가 늦어집니다.", expectedVersion: 0, publishedAt };
    expect((await call(path, { method: "POST", sub: STAFF_A, body })).status).toBe(403);
    expect((await call(path, { method: "POST", sub: OWNER_A, body: { ...body, body: "{{customerPhone}}" } })).status).toBe(400);
    expect((await call(path, { method: "POST", sub: OWNER_A, body: { ...body, publishedBy: STAFF_A } })).status).toBe(400); // 행위자 위조
    const v1 = await call(path, { method: "POST", sub: OWNER_A, body });
    expect(v1.status).toBe(201);
    expect(v1.json.data).toMatchObject({ key: "HTTP_DELAY", version: 1, variables: ["bookTitle"], publishedBy: OWNER_A });
    expect((await call(path, { method: "POST", sub: OWNER_A, body })).status).toBe(409);
    expect((await call(path, { method: "POST", sub: OWNER_A, body: { ...body, expectedVersion: 1 } })).json.data.version).toBe(2);
  });
});

describe("HTTP 서버: 고객 안내", () => {
  it("대상 생성 → 문구 복사 → 발송 시도 → 실패 결과 → 재안내가 이어지고 행위자는 토큰의 사용자이며, 위조·중복은 거부된다", async () => {
    await seedStock(4, 5);
    const o = await confirmedOrder(4, 2);
    await call(`${orders()}/${o.orderId}/lines/${o.lineId}/stock-reservations`, { method: "POST", sub: STAFF_A, body: { quantity: 2, reservedAt: "2026-03-04T06:40:00.000Z" } });
    const targets = `${orders()}/${o.orderId}/notification-targets`;
    expect((await call(targets, { method: "POST", sub: "33333333-0000-4000-8000-0000000000ff", body: { createdAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(403);
    expect((await call(targets, { method: "POST", sub: STAFF_A, body: { createdBy: OWNER_A, createdAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(400);
    const target = await call(targets, { method: "POST", sub: STAFF_A, body: { createdAt: "2026-03-04T07:00:00.000Z" } });
    expect(target.status).toBe(201);
    expect(target.json.data).toMatchObject({ mode: "FULL", securedTotal: 2, createdBy: STAFF_A });
    expect((await call(targets, { method: "POST", sub: STAFF_A, body: { createdAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(422); // 같은 확보 스냅샷

    const base = `/v1/tenants/${T_A}/notification-targets/${target.json.data.id}`;
    expect((await call(`${base}/copies`, { method: "POST", sub: STAFF_A, body: { action: "COPY", actedAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(201);
    expect((await call(`${base}/copies`, { method: "POST", sub: STAFF_A, body: { action: "PRINT", actedAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(400);
    const attempt = await call(`${base}/attempts`, { method: "POST", sub: STAFF_A, body: { channel: "PHONE", messageSnapshot: "입고되었습니다.", attemptedAt: "2026-03-04T07:00:00.000Z" } });
    expect(attempt.status).toBe(201);
    expect(attempt.json.data).toMatchObject({ channel: "PHONE", attemptedBy: STAFF_A });
    expect((await call(`${base}/attempts`, { method: "POST", sub: STAFF_A, body: { channel: "PHONE", messageSnapshot: "again", attemptedAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(422);

    const resultPath = `/v1/tenants/${T_A}/notification-attempts/${attempt.json.data.id}/result`;
    expect((await call(resultPath, { method: "POST", sub: STAFF_A, body: { outcome: "READ", note: "읽음", resultAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(400);
    const result = await call(resultPath, { method: "POST", sub: STAFF_A, body: { outcome: "FAILED", note: "부재중", resultAt: "2026-03-04T07:00:00.000Z" } });
    expect(result.status).toBe(201);
    expect(result.json.data).toMatchObject({ outcome: "FAILED", recordedBy: STAFF_A });
    const next = await call(`${base}/renotices`, { method: "POST", sub: STAFF_A, body: { createdAt: "2026-03-04T07:00:00.000Z" } });
    expect(next.status).toBe(201);
    expect(next.json.data).toMatchObject({ renoticeOfTargetId: target.json.data.id });
    expect((await call(`${base}/renotices`, { method: "POST", sub: STAFF_A, body: { createdAt: "2026-03-04T07:00:00.000Z" } })).status).toBe(422);
  });
});

