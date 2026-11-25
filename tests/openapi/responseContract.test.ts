import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 실제 서버 응답(`data`)이 `openapi/ordering-http.yaml`의 응답 스키마를 만족하는지 격리 DB로 검증한다.
 * 명세가 `data: {}`(자유 형식)이면 아무 응답이나 통과하므로, 먼저 스키마가 비어 있지 않음을 단언한다.
 */
const SECRET = "contract-test-only-secret-0123456789abcdef";
const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const SPEC = fileURLToPath(new URL("../../openapi/ordering-http.yaml", import.meta.url));
const spec = parse(readFileSync(SPEC, "utf8")) as Record<string, any>;

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER_A]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T_A, OWNER_A]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const nowSec = () => Math.floor(Date.now() / 1000);
const authorization = () => `Bearer ${signHs256({ sub: OWNER_A, aud: "authenticated", role: "authenticated", exp: nowSec() + 3600, iat: nowSec() }, SECRET, { kid: "k1" })}`;
let seq = 0;
async function call(method: "GET" | "POST", path: string, body?: unknown, query = "") {
  const headers: Record<string, string> = { authorization: authorization() };
  if (method === "POST") headers["idempotency-key"] = `contract-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method, path: `/v1/tenants/${T_A}${path}`, query: new URLSearchParams(query), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

/** 명세의 `<method> <template>` 성공(2xx) 응답 스키마(참조를 풀지 않은 원본)를 찾는다 */
const responseSchema = (template: string, method: "get" | "post" = "get") => {
  const responses = spec.paths[`/v1/tenants/{tenantId}${template}`][method].responses as Record<string, any>;
  return responses[Object.keys(responses).find((code) => code.startsWith("2"))!].content["application/json"].schema as Record<string, any>;
};
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("date-time", (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)));
ajv.addFormat("date", (v) => /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v)));
ajv.addFormat("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
const conforms = (template: string, body: unknown, method: "get" | "post" = "get") => {
  const schema = { ...responseSchema(template, method), components: spec.components };
  const ok = ajv.validate(schema, body);
  return { ok, errors: ajv.errorsText() };
};
const declared = (template: string, method: "get" | "post" = "get") => Object.keys(responseSchema(template, method).properties?.data ?? {}).length > 0;

const READS = ["/suppliers", "/suppliers/{code}"] as const;

describe("응답 계약: 공급처 조회", () => {
  it("공급처 목록·상세의 data 스키마가 선언되어 있고 실제 응답이 그것을 만족한다", async () => {
    const registered = await call("POST", "/suppliers", { code: "alpha", name: "알파 도매", orderChannel: "EMAIL", registeredAt: "2026-03-04T06:00:00.000Z" });
    expect(registered.status).toBe(201);
    const list = await call("GET", "/suppliers");
    const one = await call("GET", "/suppliers/alpha");
    expect([list.status, one.status]).toEqual([200, 200]);
    for (const t of READS) expect(declared(t), `${t} data 스키마`).toBe(true);
    expect(conforms("/suppliers", list.body)).toMatchObject({ ok: true });
    expect(conforms("/suppliers/{code}", one.body)).toMatchObject({ ok: true });
  });
});

describe("응답 계약: 도서 조회", () => {
  it("도서 목록·상세·수정 이력의 data 스키마가 선언되어 있고 실제 응답이 그것을 만족한다", async () => {
    const registered = await call("POST", "/books", { source: "MANUAL", title: "계약 책", authors: ["가나다"], isbn: "9780306406157", listPriceKrw: "12000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    expect(registered.status).toBe(201);
    const bookId = registered.body.data.id as string;
    const updated = await call("POST", `/books/${bookId}/updates`, { expectedVersion: 1, changes: { title: "계약 책 2판" }, reason: "제목 정정", changedAt: "2026-03-04T06:10:00.000Z" });
    expect(updated.status).toBe(200);
    const list = await call("GET", "/books");
    const one = await call("GET", `/books/${bookId}`);
    const revisions = await call("GET", `/books/${bookId}/revisions`);
    expect([list.status, one.status, revisions.status]).toEqual([200, 200, 200]);
    for (const t of ["/books", "/books/{bookId}", "/books/{bookId}/revisions"]) expect(declared(t), `${t} data 스키마`).toBe(true);
    expect(conforms("/books", list.body)).toMatchObject({ ok: true });
    expect(conforms("/books/{bookId}", one.body)).toMatchObject({ ok: true });
    expect(conforms("/books/{bookId}/revisions", revisions.body)).toMatchObject({ ok: true });
  });
});

describe("응답 계약: 재고 현황 조회", () => {
  it("재고 목록·단건의 data 스키마가 선언되어 있고 실제 응답이 그것을 만족한다", async () => {
    const book = await call("POST", "/books", { source: "MANUAL", title: "재고 책", listPriceKrw: "9000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const bookId = book.body.data.id as string;
    expect((await call("POST", `/books/${bookId}/initial-stock`, { quantity: 5, actedAt: "2026-03-04T06:05:00.000Z" })).status).toBe(201);
    const list = await call("GET", "/stock");
    const one = await call("GET", `/stock/${bookId}`);
    expect([list.status, one.status]).toEqual([200, 200]);
    for (const t of ["/stock", "/stock/{bookId}"]) expect(declared(t), `${t} data 스키마`).toBe(true);
    expect(conforms("/stock", list.body)).toMatchObject({ ok: true });
    expect(conforms("/stock/{bookId}", one.body)).toMatchObject({ ok: true });
  });
});

describe("응답 계약: 감사 로그·주문 결제 현황 조회", () => {
  it("감사 로그와 주문 결제 현황의 data 스키마가 선언되어 있고 실제 응답이 그것을 만족한다", async () => {
    const book = await call("POST", "/books", { source: "MANUAL", title: "결제 책", listPriceKrw: "15000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const draft = await call("POST", "/orders", { lines: [{ bookId: book.body.data.id, quantity: 2, unitPriceKrw: "15000" }] });
    expect(draft.status).toBe(201);
    const orderId = draft.body.data.id as string;
    expect((await call("POST", `/orders/${orderId}/confirm`, { expectedVersion: 1 })).status).toBe(200);
    const paid = await call("POST", `/orders/${orderId}/payments`, { method: "BANK_TRANSFER", amountKrw: "30000", externalReference: "CONTRACT-1", paidAt: "2026-03-04T06:00:00.000Z" });
    expect(paid.status).toBe(201);
    expect((await call("POST", `/payments/${paid.body.data.id}/confirmation`, { evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z" })).status).toBe(201);
    const audit = await call("GET", "/audit-log");
    const payments = await call("GET", `/orders/${orderId}/payments`);
    expect([audit.status, payments.status]).toEqual([200, 200]);
    for (const t of ["/audit-log", "/orders/{orderId}/payments"]) expect(declared(t), `${t} data 스키마`).toBe(true);
    expect(conforms("/audit-log", audit.body)).toMatchObject({ ok: true });
    expect(conforms("/orders/{orderId}/payments", payments.body)).toMatchObject({ ok: true });
  });
});

describe("응답 계약: 발주 조회", () => {
  it("발주 목록·상세의 data 스키마가 선언되어 있고, 전달 전(DRAFT)과 전달 뒤(SENT)의 실제 응답이 그것을 만족한다", async () => {
    const book = await call("POST", "/books", { source: "MANUAL", title: "발주 책", listPriceKrw: "8000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const draft = await call("POST", "/orders", { lines: [{ bookId: book.body.data.id, quantity: 3, unitPriceKrw: "8000" }] });
    const orderId = draft.body.data.id as string;
    const confirmed = await call("POST", `/orders/${orderId}/confirm`, { expectedVersion: 1 });
    const lineId = confirmed.body.data.lines[0].lineId as string;
    const allocation = await call("POST", `/orders/${orderId}/lines/${lineId}/sourcing-allocations`, { supplierCode: "alpha", quantity: 3 });
    expect(allocation.status).toBe(201);
    const po = await call("POST", "/purchase-orders", { supplierCode: "alpha", allocationIds: [allocation.body.data.id] });
    expect(po.status).toBe(201);
    const poId = po.body.data.id as string;

    const before = await call("GET", `/purchase-orders/${poId}`);
    const list = await call("GET", "/purchase-orders");
    expect([before.status, list.status]).toEqual([200, 200]);
    expect((await call("POST", `/purchase-orders/${poId}/ready`, { expectedVersion: 1 })).status).toBe(200);
    const sent = await call("POST", `/purchase-orders/${poId}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T07:00:00.000Z", referenceNumber: "REF-1" });
    expect(sent.status).toBe(200);
    const after = await call("GET", `/purchase-orders/${poId}`);
    expect(after.status).toBe(200);

    for (const t of ["/purchase-orders", "/purchase-orders/{purchaseOrderId}"]) expect(declared(t), `${t} data 스키마`).toBe(true);
    expect(conforms("/purchase-orders/{purchaseOrderId}", before.body)).toMatchObject({ ok: true });
    expect(conforms("/purchase-orders/{purchaseOrderId}", after.body)).toMatchObject({ ok: true });
    expect(conforms("/purchase-orders", list.body)).toMatchObject({ ok: true });
    expect(after.body.data.delivery).toMatchObject({ method: "EMAIL", referenceNumber: "REF-1" });
  });
});

describe("응답 계약: 템플릿·안내 대상·미수령 경고 조회", () => {
  it("세 조회의 data 스키마가 선언되어 있고 실제 응답(시도·결과·경고 포함)이 그것을 만족한다", async () => {
    const book = await call("POST", "/books", { source: "MANUAL", title: "안내 책", listPriceKrw: "7000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const bookId = book.body.data.id as string;
    expect((await call("POST", `/books/${bookId}/initial-stock`, { quantity: 2, actedAt: "2026-03-04T06:05:00.000Z" })).status).toBe(201);
    const draft = await call("POST", "/orders", { lines: [{ bookId, quantity: 2, unitPriceKrw: "7000" }] });
    const orderId = draft.body.data.id as string;
    const confirmed = await call("POST", `/orders/${orderId}/confirm`, { expectedVersion: 1 });
    const lineId = confirmed.body.data.lines[0].lineId as string;
    expect((await call("POST", `/orders/${orderId}/lines/${lineId}/stock-reservations`, { quantity: 2, reservedAt: "2026-03-04T06:10:00.000Z" })).status).toBe(201);
    const target = await call("POST", `/orders/${orderId}/notification-targets`, { mode: "FULL", createdAt: "2026-03-04T06:20:00.000Z" });
    expect(target.status).toBe(201);
    const attempt = await call("POST", `/notification-targets/${target.body.data.id}/attempts`, { channel: "PHONE", messageSnapshot: "도서가 준비되었습니다", attemptedAt: "2026-03-04T06:30:00.000Z" });
    expect(attempt.status).toBe(201);
    expect((await call("POST", `/notification-attempts/${attempt.body.data.id}/result`, { outcome: "MANUAL_RECORDED", note: "통화 완료", resultAt: "2026-03-04T06:40:00.000Z" })).status).toBe(201);
    const template = await call("POST", "/message-templates", { key: "ORDER_READY", body: "{{storeName}}입니다. {{bookTitle}} 도서가 준비되었습니다", expectedVersion: 0, publishedAt: "2026-03-04T06:00:00.000Z" });
    expect(template.status).toBe(201);

    const templates = await call("GET", "/message-templates");
    const targets = await call("GET", `/orders/${orderId}/notification-targets`);
    const warnings = await call("GET", "/long-unreceived-warnings");
    expect([templates.status, targets.status, warnings.status]).toEqual([200, 200, 200]);
    expect(warnings.body.data.length).toBeGreaterThan(0);
    for (const t of ["/message-templates", "/orders/{orderId}/notification-targets", "/long-unreceived-warnings"]) expect(declared(t), `${t} data 스키마`).toBe(true);
    expect(conforms("/message-templates", templates.body)).toMatchObject({ ok: true });
    expect(conforms("/orders/{orderId}/notification-targets", targets.body)).toMatchObject({ ok: true });
    expect(conforms("/long-unreceived-warnings", warnings.body)).toMatchObject({ ok: true });
  });
});

type Checked = { template: string; body: unknown };
describe("응답 계약(쓰기): 도서·공급처·발주·결제", () => {
  it("쓰기 응답의 data 스키마가 선언되어 있고 실제 응답이 그것을 만족한다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown, status: number) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await write("/books", "/books", { source: "MANUAL", title: "쓰기 책", listPriceKrw: "11000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" }, 201);
    await write("/books/{bookId}/updates", `/books/${book.id}/updates`, { expectedVersion: 1, changes: { title: "쓰기 책 2판" }, reason: "정정", changedAt: "2026-03-04T06:10:00.000Z" }, 200);
    await write("/suppliers", "/suppliers", { code: "gamma", name: "감마 도매", orderChannel: "WEB", registeredAt: "2026-03-04T06:00:00.000Z" }, 201);
    await write("/suppliers/{code}/updates", "/suppliers/gamma/updates", { expectedVersion: 1, changes: { name: "감마 유통" }, reason: "상호 변경", changedAt: "2026-03-04T06:10:00.000Z" }, 200);
    await write("/suppliers/{code}/activation", "/suppliers/gamma/activation", { active: false, reason: "거래 중단", changedAt: "2026-03-04T06:20:00.000Z" }, 200);
    await write("/message-templates", "/message-templates", { key: "WRITE_READY", body: "{{storeName}}입니다", expectedVersion: 0, publishedAt: "2026-03-04T06:00:00.000Z" }, 201);

    const draft = await call("POST", "/orders", { lines: [{ bookId: book.id, quantity: 2, unitPriceKrw: "11000" }] });
    const orderId = draft.body.data.id as string;
    const confirmed = await call("POST", `/orders/${orderId}/confirm`, { expectedVersion: 1 });
    const lineId = confirmed.body.data.lines[0].lineId as string;
    const payment = await write("/orders/{orderId}/payments", `/orders/${orderId}/payments`, { method: "CARD", amountKrw: "22000", externalReference: "WRITE-1", paidAt: "2026-03-04T06:00:00.000Z" }, 201);
    await write("/payments/{paymentId}/confirmation", `/payments/${payment.id}/confirmation`, { evidence: "승인 내역", confirmedAt: "2026-03-04T06:30:00.000Z" }, 201);
    const allocation = await write("/orders/{orderId}/lines/{lineId}/sourcing-allocations", `/orders/${orderId}/lines/${lineId}/sourcing-allocations`, { supplierCode: "alpha", quantity: 2 }, 201);
    const po = await write("/purchase-orders", "/purchase-orders", { supplierCode: "alpha", allocationIds: [allocation.id] }, 201);
    await write("/purchase-orders/{purchaseOrderId}/ready", `/purchase-orders/${po.id}/ready`, { expectedVersion: 1 }, 200);
    await write("/purchase-orders/{purchaseOrderId}/delivery", `/purchase-orders/${po.id}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T07:00:00.000Z" }, 200);

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

describe("응답 계약(쓰기): 입고·배분", () => {
  it("입고·불량 처리·초과 결정·정정·배분·배분 취소·재배정·해제 응답이 선언한 스키마를 만족한다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown, status: number) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await call("POST", "/books", { source: "MANUAL", title: "입고 책", listPriceKrw: "9000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const bookId = book.body.data.id as string;
    const lineOf = async (quantity: number) => {
      const draft = await call("POST", "/orders", { lines: [{ bookId, quantity, unitPriceKrw: "9000" }] });
      const confirmed = await call("POST", `/orders/${draft.body.data.id}/confirm`, { expectedVersion: 1 });
      return { orderId: draft.body.data.id as string, lineId: confirmed.body.data.lines[0].lineId as string };
    };
    const first = await lineOf(3);
    const second = await lineOf(2);
    const sourcing = await call("POST", `/orders/${first.orderId}/lines/${first.lineId}/sourcing-allocations`, { supplierCode: "alpha", quantity: 3 });
    const sourcingSecond = await call("POST", `/orders/${second.orderId}/lines/${second.lineId}/sourcing-allocations`, { supplierCode: "alpha", quantity: 2 });
    const po = await call("POST", "/purchase-orders", { supplierCode: "alpha", allocationIds: [sourcing.body.data.id, sourcingSecond.body.data.id] });
    const poId = po.body.data.id as string;
    await call("POST", `/purchase-orders/${poId}/ready`, { expectedVersion: 1 });
    await call("POST", `/purchase-orders/${poId}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T07:00:00.000Z" });
    const poLineId = (await call("GET", `/purchase-orders/${poId}`)).body.data.lines[0].poLineId as string;

    const receipt = await write("/purchase-orders/{purchaseOrderId}/receipts", `/purchase-orders/${poId}/receipts`, { poLineId, normalQuantity: 6, damagedQuantity: 1, misdeliveredQuantity: 0, receivedAt: "2026-03-05T06:00:00.000Z" }, 201);
    await write("/receipts/{receiptId}/defect-resolutions", `/receipts/${receipt.id}/defect-resolutions`, { kind: "DAMAGED", quantity: 1, outcome: "RETURNED_TO_SUPPLIER", evidence: "반품 접수증", resolvedAt: "2026-03-05T07:00:00.000Z" }, 201);
    await write("/receipts/{receiptId}/excess-decisions", `/receipts/${receipt.id}/excess-decisions`, { decision: "APPROVED", quantity: 1, reason: "재고 편입 승인", decidedAt: "2026-03-05T07:10:00.000Z" }, 201);
    const allocation = await write("/receipts/{receiptId}/allocations", `/receipts/${receipt.id}/allocations`, { orderId: first.orderId, orderLineId: first.lineId, quantity: 3, allocatedAt: "2026-03-05T07:20:00.000Z" }, 201);
    await write("/allocations/{allocationId}/cancellations", `/allocations/${allocation.id}/cancellations`, { quantity: 1, reason: "고객 변심", cancelledAt: "2026-03-05T07:30:00.000Z" }, 201);
    await write("/allocations/{allocationId}/reallocations", `/allocations/${allocation.id}/reallocations`, { toOrderId: second.orderId, toOrderLineId: second.lineId, quantity: 1, reason: "다른 주문에 배정", actedAt: "2026-03-05T07:40:00.000Z" }, 201);
    await write("/allocations/{allocationId}/releases", `/allocations/${allocation.id}/releases`, { quantity: 1, reason: "배분 해제", releasedAt: "2026-03-05T07:50:00.000Z" }, 201);
    await write("/receipts/{receiptId}/corrections", `/receipts/${receipt.id}/corrections`, { quantity: 1, reason: "수량 오기록", correctedAt: "2026-03-05T08:00:00.000Z" }, 201);

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

describe("응답 계약(쓰기): 재고·수령·결제 정정", () => {
  it("초기 재고·조정·예약·예약 해제·수령·수령 정정·결제 무효·결제 정정 응답이 선언한 스키마를 만족한다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown, status: number) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await call("POST", "/books", { source: "MANUAL", title: "정정 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const bookId = book.body.data.id as string;
    await write("/books/{bookId}/initial-stock", `/books/${bookId}/initial-stock`, { quantity: 5, actedAt: "2026-03-04T06:05:00.000Z" }, 201);
    await write("/books/{bookId}/stock-adjustments", `/books/${bookId}/stock-adjustments`, { direction: "IN", quantity: 2, reason: "실사 반영", actedAt: "2026-03-04T06:06:00.000Z" }, 201);
    const draft = await call("POST", "/orders", { lines: [{ bookId, quantity: 3, unitPriceKrw: "10000" }] });
    const orderId = draft.body.data.id as string;
    const confirmed = await call("POST", `/orders/${orderId}/confirm`, { expectedVersion: 1 });
    const lineId = confirmed.body.data.lines[0].lineId as string;
    const reservation = await write("/orders/{orderId}/lines/{lineId}/stock-reservations", `/orders/${orderId}/lines/${lineId}/stock-reservations`, { quantity: 3, reservedAt: "2026-03-04T06:10:00.000Z" }, 201);
    await write("/stock-reservations/{reservationId}/releases", `/stock-reservations/${reservation.id}/releases`, { quantity: 1, reason: "수량 조정", releasedAt: "2026-03-04T06:15:00.000Z" }, 201);

    const paid = await call("POST", `/orders/${orderId}/payments`, { method: "BANK_TRANSFER", amountKrw: "20000", externalReference: "CORR-1", paidAt: "2026-03-04T06:00:00.000Z" });
    await call("POST", `/payments/${paid.body.data.id}/confirmation`, { evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z" });
    const unconfirmed = await call("POST", `/orders/${orderId}/payments`, { method: "CARD", amountKrw: "5000", externalReference: "CORR-2", paidAt: "2026-03-04T06:01:00.000Z" });
    await write("/payments/{paymentId}/void", `/payments/${unconfirmed.body.data.id}/void`, { reason: "중복 입력", voidedAt: "2026-03-04T06:40:00.000Z" }, 201);
    await write("/payments/{paymentId}/corrections", `/payments/${paid.body.data.id}/corrections`, { reducedKrw: "1000", reason: "금액 오기록", evidence: "입금 내역 재확인", correctedAt: "2026-03-04T06:50:00.000Z" }, 201);

    const fulfillment = await write("/orders/{orderId}/fulfillments", `/orders/${orderId}/fulfillments`, { orderLineId: lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 2 }], receivedAt: "2026-03-04T07:00:00.000Z" }, 201);
    await write("/orders/{orderId}/fulfillments/{fulfillmentId}/corrections", `/orders/${orderId}/fulfillments/${fulfillment.id}/corrections`, { quantity: 1, restorations: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }], reason: "반품 입고", evidence: "반입 확인서", physicalReturnConfirmed: true, correctedAt: "2026-03-04T07:30:00.000Z" }, 201);

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

