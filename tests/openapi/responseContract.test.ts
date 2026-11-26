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

/** 지정한 사용자(와 이메일 claim)로 전체 경로(`/v1/...`)를 호출한다. 계정 범위 경로와 다른 사용자의 요청에 쓴다 */
async function callAs(sub: string, email: string | undefined, method: "GET" | "POST", fullPath: string, body?: unknown) {
  const token = signHs256({ sub, aud: "authenticated", role: "authenticated", exp: nowSec() + 3600, iat: nowSec(), ...(email ? { email } : {}) }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "POST") headers["idempotency-key"] = `contract-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method, path: fullPath, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

/** 명세의 `<method> <template>` 성공(2xx) 응답 스키마(참조를 풀지 않은 원본)를 찾는다 */
const responseSchema = (template: string, method: "get" | "post" = "get") => {
  const responses = spec.paths[template.startsWith("/v1/") ? template : `/v1/tenants/{tenantId}${template}`][method].responses as Record<string, any>;
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

    // 안내 대기 큐(O-08): 시도·결과가 기록된 대상이 선언한 스키마를 만족하고 문구·메모는 나오지 않는다
    const queue = await call("GET", "/notification-targets");
    expect(queue.status).toBe(200);
    expect(queue.body.data.items.some((i: { id: string; status: string }) => i.id === target.body.data.id && i.status === "MANUAL_RECORDED")).toBe(true);
    expect(declared("/notification-targets", "get"), "큐 data 스키마").toBe(true);
    expect(conforms("/notification-targets", queue.body)).toMatchObject({ ok: true });
    expect(JSON.stringify(queue.body)).not.toMatch(/도서가 준비되었습니다|통화 완료/);
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

    // 입고 목록·상세(O-07): 배분·해제·정정·불량·초과 이력이 모두 있는 입고가 선언한 스키마를 만족한다
    const detail = await call("GET", `/receipts/${receipt.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.allocations.length).toBeGreaterThan(0);
    expect(detail.body.data.corrections).toHaveLength(1);
    expect(detail.body.data.defectResolutions).toHaveLength(1);
    expect(detail.body.data.excessDecisions).toHaveLength(1);
    const receiptList = await call("GET", "/receipts");
    expect(receiptList.body.data.items.some((i: { id: string }) => i.id === receipt.id)).toBe(true);
    for (const template of ["/receipts/{receiptId}", "/receipts"]) expect(declared(template, "get"), `${template} data 스키마`).toBe(true);
    expect(conforms("/receipts/{receiptId}", detail.body), "입고 상세").toMatchObject({ ok: true });
    expect(conforms("/receipts", receiptList.body), "입고 목록").toMatchObject({ ok: true });
    // 스키마가 실제로 닫혀 있다(알 수 없는 필드가 새면 잡힌다)
    expect(conforms("/receipts/{receiptId}", { data: { ...detail.body.data, leaked: "x" } }), "상세 알 수 없는 필드").toMatchObject({ ok: false });
    expect(conforms("/receipts", { data: { items: [{ ...receiptList.body.data.items[0], leaked: "x" }] } }), "목록 알 수 없는 필드").toMatchObject({ ok: false });

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

    // 수령·결제 현황(O-09): 결제·수령·정정이 있는 주문이 선언한 스키마를 만족하고, 결제 숫자는 주문별 결제 요약과 같다
    const settlements = await call("GET", "/order-settlements", undefined, "includeClosed=true");
    expect(settlements.status).toBe(200);
    const mine = settlements.body.data.items.find((i: { orderId: string }) => i.orderId === orderId);
    expect(mine).toBeDefined();
    expect(mine.deliveredQuantity).toBe(1); // 수령 2 − 정정 1
    const paymentsView = await call("GET", `/orders/${orderId}/payments`);
    expect({ totalKrw: mine.totalKrw, confirmedKrw: mine.confirmedKrw, pendingKrw: mine.pendingKrw, balanceKrw: mine.balanceKrw, refundRequiredKrw: mine.refundRequiredKrw }).toEqual(paymentsView.body.data.summary);
    expect(declared("/order-settlements", "get"), "현황 data 스키마").toBe(true);
    expect(conforms("/order-settlements", settlements.body)).toMatchObject({ ok: true });

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

describe("응답 계약(쓰기): 초안 보류·재개·폐기", () => {
  it("보류·재개·폐기 응답(보류·폐기 필드 포함)이 선언한 스키마를 만족하고, 상세·목록에도 폐기 필드가 나온다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(200);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await call("POST", "/books", { source: "MANUAL", title: "보류 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const draft = await call("POST", "/orders", { lines: [{ bookId: book.body.data.id, quantity: 1, unitPriceKrw: "10000" }] });
    const orderId = draft.body.data.id as string;
    const held = await write("/orders/{orderId}/hold", `/orders/${orderId}/hold`, { expectedVersion: 1, reason: "입금 확인 중", heldAt: "2026-03-04T06:10:00.000Z" });
    expect(held).toMatchObject({ heldAt: "2026-03-04T06:10:00.000Z", holdReason: "입금 확인 중" });
    const resumed = await write("/orders/{orderId}/resume", `/orders/${orderId}/resume`, { expectedVersion: held.version, resumedAt: "2026-03-04T06:20:00.000Z" });
    await write("/orders/{orderId}/discard", `/orders/${orderId}/discard`, { expectedVersion: resumed.version, reason: "고객 철회", discardedAt: "2026-03-04T06:30:00.000Z" });

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
    const history = await call("GET", `/orders/${orderId}/history`);
    expect(history.status).toBe(200);
    expect(history.body.data.map((e: { kind: string }) => e.kind)).toEqual(["HOLD", "RESUME", "DISCARD"]);
    expect(declared("/orders/{orderId}/history", "get"), "이력 data 스키마").toBe(true);
    expect(conforms("/orders/{orderId}/history", history.body, "get"), "이력").toMatchObject({ ok: true });
    const detail = await call("GET", `/orders/${orderId}`);
    expect(detail.body.data).toMatchObject({ discardedAt: "2026-03-04T06:30:00.000Z", discardReason: "고객 철회" });
    const list = await call("GET", "/orders", undefined, "includeDiscarded=true");
    expect(JSON.stringify(list.body.data.items)).toContain("discardedAt");
  });
});

describe("응답 계약(읽기): 대시보드", () => {
  it("대시보드 집계 응답(since 유무)이 선언한 스키마를 만족한다", async () => {
    const plain = await call("GET", "/dashboard");
    const withSince = await call("GET", "/dashboard", undefined, "since=2020-01-01T00:00:00.000Z");
    expect(plain.status).toBe(200);
    expect(withSince.status).toBe(200);
    expect(withSince.body.data.receivedSince).toBeGreaterThanOrEqual(0);
    expect(declared("/dashboard", "get"), "data 스키마").toBe(true);
    expect(conforms("/dashboard", plain.body)).toMatchObject({ ok: true });
    expect(conforms("/dashboard", withSince.body)).toMatchObject({ ok: true });

  });
});

describe("응답 계약(쓰기): 주문 취소·종결·취소 물량 처분·반품", () => {
  it("취소 요청·결정·적용·종결 요청과 재고 편입·반품 요청·회신·출고·예외·해소·재협의·완료 응답이 선언한 스키마를 만족한다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown, status: number) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await call("POST", "/books", { source: "MANUAL", title: "취소 책", listPriceKrw: "9000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const bookId = book.body.data.id as string;
    await call("POST", `/books/${bookId}/initial-stock`, { quantity: 1, actedAt: "2026-03-04T06:05:00.000Z" });
    const lineOf = async (quantity: number) => {
      const draft = await call("POST", "/orders", { lines: [{ bookId, quantity, unitPriceKrw: "9000" }] });
      const confirmed = await call("POST", `/orders/${draft.body.data.id}/confirm`, { expectedVersion: 1 });
      return { orderId: draft.body.data.id as string, lineId: confirmed.body.data.lines[0].lineId as string, version: 2 };
    };

    // 주문 취소 → 결정 → 적용 → 종결 요청
    const plain = await lineOf(2);
    const request = await write("/orders/{orderId}/cancellation-requests", `/orders/${plain.orderId}/cancellation-requests`, { orderLineId: plain.lineId, quantity: 2, reason: "고객 요청", expectedVersion: plain.version, requestedAt: "2026-03-04T07:00:00.000Z" }, 201);
    await write("/order-cancellation-requests/{requestId}/decision", `/order-cancellation-requests/${request.id}/decision`, { decision: "APPROVED", decidedAt: "2026-03-04T07:10:00.000Z" }, 200);
    await write("/order-cancellation-requests/{requestId}/application", `/order-cancellation-requests/${request.id}/application`, { appliedAt: "2026-03-04T07:20:00.000Z" }, 201);
    const version = (await call("GET", `/orders/${plain.orderId}`)).body.data.version as number;
    await write("/orders/{orderId}/closure-requests", `/orders/${plain.orderId}/closure-requests`, { expectedVersion: version, requestedAt: "2026-03-04T07:30:00.000Z" }, 201);

    // 입고 후 배분했다가 취소한 물량의 처분
    const target = await lineOf(5);
    const sourcing = await call("POST", `/orders/${target.orderId}/lines/${target.lineId}/sourcing-allocations`, { supplierCode: "alpha", quantity: 5 });
    const po = await call("POST", "/purchase-orders", { supplierCode: "alpha", allocationIds: [sourcing.body.data.id] });
    const poId = po.body.data.id as string;
    await call("POST", `/purchase-orders/${poId}/ready`, { expectedVersion: 1 });
    await call("POST", `/purchase-orders/${poId}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T08:00:00.000Z" });
    const poLineId = (await call("GET", `/purchase-orders/${poId}`)).body.data.lines[0].poLineId as string;
    const receipt = await call("POST", `/purchase-orders/${poId}/receipts`, { poLineId, normalQuantity: 5, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-05T06:00:00.000Z" });
    const allocation = await call("POST", `/receipts/${receipt.body.data.id}/allocations`, { orderId: target.orderId, orderLineId: target.lineId, quantity: 5, allocatedAt: "2026-03-05T07:00:00.000Z" });
    const cancelOne = await call("POST", `/allocations/${allocation.body.data.id}/cancellations`, { quantity: 1, reason: "취소 1", cancelledAt: "2026-03-05T07:10:00.000Z" });
    const cancelRest = await call("POST", `/allocations/${allocation.body.data.id}/cancellations`, { quantity: 4, reason: "취소 4", cancelledAt: "2026-03-05T07:20:00.000Z" });
    await write("/allocation-cancellations/{cancellationId}/stock-intakes", `/allocation-cancellations/${cancelOne.body.data.id}/stock-intakes`, { quantity: 1, actedAt: "2026-03-05T07:30:00.000Z" }, 201);
    const returnRequest = await write("/allocation-cancellations/{cancellationId}/return-requests", `/allocation-cancellations/${cancelRest.body.data.id}/return-requests`, { quantity: 4, requestedAt: "2026-03-05T07:40:00.000Z" }, 201);
    await write("/return-requests/{requestId}/replies", `/return-requests/${returnRequest.id}/replies`, { acceptedQuantity: 3, rejectedQuantity: 1, evidence: "공급처 회신", repliedAt: "2026-03-05T07:50:00.000Z" }, 201);
    await write("/return-requests/{requestId}/dispatches", `/return-requests/${returnRequest.id}/dispatches`, { quantity: 3, dispatchedAt: "2026-03-05T08:00:00.000Z", referenceNumber: "TRK-1" }, 201);
    const exception = await write("/return-requests/{requestId}/exceptions", `/return-requests/${returnRequest.id}/exceptions`, { quantity: 1, kind: "LOST", evidence: "운송장 분실", reportedAt: "2026-03-05T08:10:00.000Z" }, 201);
    await write("/return-exceptions/{exceptionId}/resolutions", `/return-exceptions/${exception.id}/resolutions`, { outcome: "RETURNED", quantity: 1, evidence: "공급처 확인", resolvedAt: "2026-03-05T08:20:00.000Z" }, 201);
    await write("/return-requests/{requestId}/renegotiations", `/return-requests/${returnRequest.id}/renegotiations`, { quantity: 1, retryReason: "재협의", requestedAt: "2026-03-05T08:30:00.000Z" }, 201);
    await write("/return-requests/{requestId}/completions", `/return-requests/${returnRequest.id}/completions`, { quantity: 2, evidence: "반품 완료 확인", confirmedAt: "2026-03-05T08:40:00.000Z" }, 201);

    // 취소 물량 처분 현황(R-01·R-03): 편입·반품·예외·재협의·완료를 거친 물량이 선언한 스키마를 만족하고 다섯 수량의 합이 취소 수량과 같다
    const dispositionList = await call("GET", "/allocation-cancellations");
    expect(dispositionList.status).toBe(200);
    expect(dispositionList.body.data.items.length).toBeGreaterThan(0);
    for (const item of dispositionList.body.data.items as Record<string, number>[]) {
      expect(item.pendingDispositionQuantity! + item.stockTransferredQuantity! + item.returnHeldQuantity! + item.returnDispatchedQuantity! + item.returnedFinalQuantity!, JSON.stringify(item)).toBe(item.quantity);
    }
    expect(declared("/allocation-cancellations", "get"), "처분 현황 data 스키마").toBe(true);
    expect(conforms("/allocation-cancellations", dispositionList.body)).toMatchObject({ ok: true });

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

describe("응답 계약(쓰기): 직원 초대·계정", () => {
  it("서점 개설·직원 초대·수락·철회·상태 변경 응답이 선언한 스키마를 만족한다", async () => {
    const checked: Checked[] = [];
    const record = (template: string, res: { status: number; body: any }, status: number) => {
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const ownerId = "55555555-0000-4000-8000-000000000001";
    const staffId = "55555555-0000-4000-8000-000000000002";
    const store = record("/v1/stores", await callAs(ownerId, "owner@shop.test", "POST", "/v1/stores", { storeName: "계약 서점" }), 201);
    const base = `/v1/tenants/${store.tenant.id}`;
    const invited = record("/staff-invitations", await callAs(ownerId, "owner@shop.test", "POST", `${base}/staff-invitations`, { email: "staff@shop.test", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), 201);
    record("/v1/invitations/accept", await callAs(staffId, "staff@shop.test", "POST", "/v1/invitations/accept", { token: invited.token }), 201);
    record("/members/{targetUserId}/status", await callAs(ownerId, "owner@shop.test", "POST", `${base}/members/${staffId}/status`, { status: "INACTIVE" }), 200);
    const second = record("/staff-invitations", await callAs(ownerId, "owner@shop.test", "POST", `${base}/staff-invitations`, { email: "other@shop.test", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), 201);
    record("/staff-invitations/{invitationId}/revocation", await callAs(ownerId, "owner@shop.test", "POST", `${base}/staff-invitations/${second.invitation.id}/revocation`, {}), 201);

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });

    // 서점 기본정보·설정 변경(S-01·S-07): 직원이 읽고 Owner가 바꾼다
    const storeInfo = await callAs(ownerId, undefined, "GET", `${base}/store`);
    expect(storeInfo.status).toBe(200);
    expect(storeInfo.body.data).toMatchObject({ id: store.tenant.id, name: "계약 서점", longUnreceivedWarningDays: 7, myRole: "OWNER" });
    const settings = await callAs(ownerId, "owner@shop.test", "POST", `${base}/store/settings`, { name: "계약 서점 개명", longUnreceivedWarningDays: 14 });
    expect(settings.status).toBe(200);
    for (const [template, method, body] of [["/store", "get", storeInfo.body], ["/store/settings", "post", settings.body]] as const) {
      expect(declared(template, method), `${template} data 스키마`).toBe(true);
      expect(conforms(template, body, method), template).toMatchObject({ ok: true });
    }
    expect((await callAs(ownerId, undefined, "GET", `${base}/store`)).body.data).toMatchObject({ name: "계약 서점 개명", longUnreceivedWarningDays: 14 });

    // 위임 부여·회수와 현재 위임 목록(S-03): 활성 직원 하나를 새로 만들어 위임을 주고 거둔다
    const delegateId = "55555555-0000-4000-8000-000000000003";
    const delegateInvite = await callAs(ownerId, "owner@shop.test", "POST", `${base}/staff-invitations`, { email: "delegate@shop.test", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await callAs(delegateId, "delegate@shop.test", "POST", "/v1/invitations/accept", { token: delegateInvite.body.data.token });
    const grant = await callAs(ownerId, "owner@shop.test", "POST", `${base}/members/${delegateId}/delegations`, { kind: "STOCK_ADJUSTMENT", delegated: true });
    expect(grant.status).toBe(200);
    const delegationList = await callAs(ownerId, undefined, "GET", `${base}/delegations`);
    expect(delegationList.body.data).toEqual([{ userId: delegateId, kind: "STOCK_ADJUSTMENT", delegatedBy: ownerId, delegatedAt: expect.any(String) }]);
    expect(declared("/members/{targetUserId}/delegations", "post"), "위임 data 스키마").toBe(true);
    expect(declared("/delegations", "get"), "위임 목록 data 스키마").toBe(true);
    expect(conforms("/members/{targetUserId}/delegations", grant.body, "post"), "위임 부여").toMatchObject({ ok: true });
    expect(conforms("/delegations", delegationList.body, "get"), "위임 목록").toMatchObject({ ok: true });
    expect((await callAs(ownerId, "owner@shop.test", "POST", `${base}/members/${delegateId}/delegations`, { kind: "STOCK_ADJUSTMENT", delegated: false })).status).toBe(200);

    // 직원·초대 목록(S-02): Owner만. 수락·철회·대기 초대가 모두 있다
    const members = await callAs(ownerId, undefined, "GET", `${base}/members`);
    expect(members.status).toBe(200);
    expect(members.body.data.map((m: { userId: string; status: string }) => [m.userId, m.status])).toEqual([[ownerId, "ACTIVE"], [staffId, "INACTIVE"], [delegateId, "ACTIVE"]]); // Owner 먼저, 합류 순
    const invitationList = await callAs(ownerId, undefined, "GET", `${base}/staff-invitations`);
    expect(invitationList.status).toBe(200);
    expect(invitationList.body.data.map((i: { status: string }) => i.status).sort()).toEqual(["ACCEPTED", "ACCEPTED", "REVOKED"]);
    expect(JSON.stringify(invitationList.body)).not.toMatch(/token/i);
    for (const [template, res] of [["/members", members], ["/staff-invitations", invitationList]] as const) {
      expect(declared(template, "get"), `${template} data 스키마`).toBe(true);
      expect(conforms(template, res.body, "get"), template).toMatchObject({ ok: true });
    }

    // 내 서점 목록(A-05): 방금 연 서점이 Owner로 나온다
    const mine = await callAs(ownerId, undefined, "GET", "/v1/me/memberships");
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual([{ tenantId: store.tenant.id, tenantName: "계약 서점 개명", role: "OWNER" }]); // 위에서 이름을 바꿨다
    expect(declared("/v1/me/memberships", "get"), "내 서점 목록 data 스키마").toBe(true);
    expect(conforms("/v1/me/memberships", mine.body, "get"), "내 서점 목록").toMatchObject({ ok: true });
  });
});

describe("응답 계약(쓰기): 환급", () => {
  it("환급 업무·요청·시도 보고·시도 해소·요청 결정 응답이 선언한 스키마를 만족한다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown, status: number) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await call("POST", "/books", { source: "MANUAL", title: "환급 책", listPriceKrw: "15000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const draft = await call("POST", "/orders", { lines: [{ bookId: book.body.data.id, quantity: 1, unitPriceKrw: "15000" }] });
    const orderId = draft.body.data.id as string;
    await call("POST", `/orders/${orderId}/confirm`, { expectedVersion: 1 });
    const paid = await call("POST", `/orders/${orderId}/payments`, { method: "BANK_TRANSFER", amountKrw: "20000", externalReference: "REFUND-1", paidAt: "2026-03-04T06:00:00.000Z" });
    const paymentId = paid.body.data.id as string;
    await call("POST", `/payments/${paymentId}/confirmation`, { evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z" });

    const task = await write("/orders/{orderId}/refund-tasks", `/orders/${orderId}/refund-tasks`, { openedAt: "2026-03-04T07:00:00.000Z" }, 201);
    const request = await write("/refund-tasks/{taskId}/refund-requests", `/refund-tasks/${task.id}/refund-requests`, { paymentId, amountKrw: "3000", evidence: "고객 환급 요청", requestedAt: "2026-03-04T07:10:00.000Z" }, 201);
    const attempt = await write("/refund-tasks/{taskId}/refund-attempts", `/refund-tasks/${task.id}/refund-attempts`, { paymentId, amountKrw: "2000", result: "UNKNOWN", reason: "이체 결과 불명", reportedAt: "2026-03-04T07:20:00.000Z" }, 201);
    await write("/refund-attempts/{attemptId}/resolution", `/refund-attempts/${attempt.id}/resolution`, { outcome: "CONFIRMED", evidence: "이체 내역 확인", resolvedAt: "2026-03-04T07:30:00.000Z" }, 201);
    await write("/refund-requests/{requestId}/decision", `/refund-requests/${request.id}/decision`, { decision: "APPROVED", decidedAt: "2026-03-04T07:40:00.000Z" }, 200);

    // 환급 필요 업무 목록(O-09-04): 요청·시도가 있는 업무가 선언한 스키마를 만족한다
    const tasks = await call("GET", "/refund-tasks");
    expect(tasks.status).toBe(200);
    const mine = tasks.body.data.items.find((i: { id: string }) => i.id === task.id);
    expect(mine).toMatchObject({ orderId, status: "PARTIAL", pendingRequests: 0, unresolvedAttempts: 0 }); // 승인된 요청이 일부를 환급했고 시도는 해소됐다
    expect(BigInt(mine.refundedKrw) + BigInt(mine.remainingKrw)).toBe(BigInt(mine.requiredKrw));
    expect(declared("/refund-tasks", "get"), "환급 업무 data 스키마").toBe(true);
    expect(conforms("/refund-tasks", tasks.body)).toMatchObject({ ok: true });
    expect(JSON.stringify(tasks.body)).not.toMatch(/evidence|증빙/);

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

describe("응답 계약(쓰기): 고객 안내", () => {
  it("안내 대상·문구 복사·발송 시도·결과·재안내 응답이 선언한 스키마를 만족한다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown, status: number) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await call("POST", "/books", { source: "MANUAL", title: "안내쓰기 책", listPriceKrw: "6000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const bookId = book.body.data.id as string;
    await call("POST", `/books/${bookId}/initial-stock`, { quantity: 2, actedAt: "2026-03-04T06:05:00.000Z" });
    const draft = await call("POST", "/orders", { lines: [{ bookId, quantity: 2, unitPriceKrw: "6000" }] });
    const orderId = draft.body.data.id as string;
    const confirmed = await call("POST", `/orders/${orderId}/confirm`, { expectedVersion: 1 });
    const lineId = confirmed.body.data.lines[0].lineId as string;
    await call("POST", `/orders/${orderId}/lines/${lineId}/stock-reservations`, { quantity: 2, reservedAt: "2026-03-04T06:10:00.000Z" });

    const target = await write("/orders/{orderId}/notification-targets", `/orders/${orderId}/notification-targets`, { mode: "FULL", createdAt: "2026-03-04T06:20:00.000Z" }, 201);
    await write("/notification-targets/{targetId}/copies", `/notification-targets/${target.id}/copies`, { action: "COPY", actedAt: "2026-03-04T06:25:00.000Z" }, 201);
    const attempt = await write("/notification-targets/{targetId}/attempts", `/notification-targets/${target.id}/attempts`, { channel: "SMS", messageSnapshot: "도서가 준비되었습니다", attemptedAt: "2026-03-04T06:30:00.000Z" }, 201);
    await write("/notification-attempts/{attemptId}/result", `/notification-attempts/${attempt.id}/result`, { outcome: "FAILED", note: "수신 거부", resultAt: "2026-03-04T06:40:00.000Z" }, 201);
    await write("/notification-targets/{targetId}/renotices", `/notification-targets/${target.id}/renotices`, { createdAt: "2026-03-04T06:50:00.000Z" }, 201);

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

describe("응답 계약(쓰기): 발주 회신·취소, 배정 해제, 중복 위험 승인", () => {
  it("공급처 회신·발주 취소 요청·응답·확정·미전달 발주 취소·배정 해제·중복 위험 승인 응답이 선언한 스키마를 만족한다", async () => {
    const checked: Checked[] = [];
    const write = async (template: string, path: string, body: unknown, status: number) => {
      const res = await call("POST", path, body);
      expect(res.status, `${template} 상태 ${JSON.stringify(res.body)}`).toBe(status);
      checked.push({ template, body: res.body });
      return res.body.data;
    };
    const book = await call("POST", "/books", { source: "MANUAL", title: "발주취소 책", listPriceKrw: "5000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    const bookId = book.body.data.id as string;
    const lineOf = async (quantity: number) => {
      const draft = await call("POST", "/orders", { lines: [{ bookId, quantity, unitPriceKrw: "5000" }] });
      const confirmed = await call("POST", `/orders/${draft.body.data.id}/confirm`, { expectedVersion: 1 });
      return { orderId: draft.body.data.id as string, lineId: confirmed.body.data.lines[0].lineId as string };
    };
    const purchaseOrderOf = async (line: { orderId: string; lineId: string }, quantity: number, send: boolean) => {
      const sourcing = await call("POST", `/orders/${line.orderId}/lines/${line.lineId}/sourcing-allocations`, { supplierCode: "alpha", quantity });
      const po = await call("POST", "/purchase-orders", { supplierCode: "alpha", allocationIds: [sourcing.body.data.id] });
      const poId = po.body.data.id as string;
      if (send) {
        await call("POST", `/purchase-orders/${poId}/ready`, { expectedVersion: 1 });
        await call("POST", `/purchase-orders/${poId}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T07:00:00.000Z" });
      }
      const got = (await call("GET", `/purchase-orders/${poId}`)).body.data;
      return { poId, poLineId: got.lines[0].poLineId as string, version: got.version as number, allocationId: sourcing.body.data.id as string };
    };

    // 전달한 발주: 공급처 회신 → 취소 요청 → 응답 → 취소 확정
    const sentLine = await lineOf(2);
    const sent = await purchaseOrderOf(sentLine, 2, true);
    await write("/purchase-orders/{purchaseOrderId}/supplier-replies", `/purchase-orders/${sent.poId}/supplier-replies`, { poLineId: sent.poLineId, kind: "CONFIRM", quantity: 2, source: "UNANSWERED", evidence: "공급처 확인 메일", repliedAt: "2026-03-04T08:00:00.000Z" }, 201);
    const cancelRequest = await write("/purchase-orders/{purchaseOrderId}/lines/{poLineId}/cancellation-requests", `/purchase-orders/${sent.poId}/lines/${sent.poLineId}/cancellation-requests`, { quantity: 2, reason: "주문 취소" }, 201);
    await write("/purchase-orders/{purchaseOrderId}/cancellation-requests/{requestId}/responses", `/purchase-orders/${sent.poId}/cancellation-requests/${cancelRequest.id}/responses`, { acceptedQuantity: 2, rejectedQuantity: 0, evidence: "공급처 취소 수락", repliedAt: "2026-03-04T09:00:00.000Z" }, 201);
    const sentVersion = (await call("GET", `/purchase-orders/${sent.poId}`)).body.data.version as number;
    await write("/purchase-orders/{purchaseOrderId}/cancellation-confirmation", `/purchase-orders/${sent.poId}/cancellation-confirmation`, { expectedVersion: sentVersion }, 200);

    // 전달하지 않은 발주 취소
    const draftLine = await lineOf(1);
    const unsent = await purchaseOrderOf(draftLine, 1, false);
    await write("/purchase-orders/{purchaseOrderId}/cancellation", `/purchase-orders/${unsent.poId}/cancellation`, { expectedVersion: unsent.version, reason: "발주 철회", cancelledAt: "2026-03-04T09:30:00.000Z" }, 200);

    // 발주에 묶이지 않은 배정 해제
    const freeLine = await lineOf(1);
    const free = await call("POST", `/orders/${freeLine.orderId}/lines/${freeLine.lineId}/sourcing-allocations`, { supplierCode: "alpha", quantity: 1 });
    await write("/sourcing-allocations/{allocationId}/releases", `/sourcing-allocations/${free.body.data.id}/releases`, { reason: "배정 취소", releasedAt: "2026-03-04T10:00:00.000Z" }, 201);

    // 열려 있는 공급처 의무가 있는 품목의 중복 위험 승인
    const riskLine = await lineOf(2);
    const risk = await purchaseOrderOf(riskLine, 2, true);
    const released = await write("/sourcing-allocations/{allocationId}/releases", `/sourcing-allocations/${risk.allocationId}/releases`, { reason: "고객이 주문 변경", releasedAt: "2026-03-04T10:30:00.000Z" }, 201);
    expect(released.retainedObligations?.length ?? 0, "전달된 발주의 배정을 풀면 공급처 의무가 남는다").toBeGreaterThan(0);
    await write("/orders/{orderId}/lines/{lineId}/duplicate-risk-approvals", `/orders/${riskLine.orderId}/lines/${riskLine.lineId}/duplicate-risk-approvals`, { purchaseOrderId: risk.poId, poLineId: risk.poLineId, surplusPlan: "STOCK_INTAKE", planNote: "남는 수량은 재고로 편입", approvedAt: "2026-03-04T11:00:00.000Z" }, 201);

    for (const { template } of checked) expect(declared(template, "post"), `${template} data 스키마`).toBe(true);
    for (const { template, body } of checked) expect(conforms(template, body, "post"), template).toMatchObject({ ok: true });
  });
});

describe("응답 계약(읽기): 예외 업무 큐", () => {
  it("앞선 시험이 남긴 실제 상태(미확인·환급·안내 등)의 예외 큐가 선언한 스키마를 만족하고 대시보드 건수와 일치한다", async () => {
    const dashboard = await call("GET", "/dashboard");
    const queue = await call("GET", "/exceptions", undefined, "limit=100");
    expect(queue.status).toBe(200);
    expect(queue.body.data.items.length).toBeGreaterThan(0);
    expect(declared("/exceptions", "get"), "예외 data 스키마").toBe(true);
    expect(conforms("/exceptions", queue.body)).toMatchObject({ ok: true });
    const items = queue.body.data.items as { type: string }[];
    expect(queue.body.data.nextCursor).toBeUndefined(); // 100건 안에 다 들어온다
    const d = dashboard.body.data;
    expect(items.filter((i) => i.type === "REFUND_REQUIRED").length).toBe(d.refunds.required + d.refunds.partial);
    expect(items.filter((i) => i.type === "UNCONFIRMED_PAYMENT").length).toBe(d.payments.unconfirmedPayments);
    expect(items.filter((i) => i.type === "FAILED_NOTIFICATION").length).toBe(d.notifications.failed);
  });
});

describe("응답 계약(읽기): 공급처별 현황", () => {
  it("앞선 시험이 만든 공급처·발주의 공급처별 현황이 선언한 스키마를 만족하고 대시보드 발주 건수를 넘지 않는다", async () => {
    const overview = await call("GET", "/supplier-overview");
    expect(overview.status).toBe(200);
    expect(overview.body.data.items.length).toBeGreaterThan(0);
    expect(declared("/supplier-overview", "get"), "공급처 현황 data 스키마").toBe(true);
    expect(conforms("/supplier-overview", overview.body)).toMatchObject({ ok: true });
    const dashboard = (await call("GET", "/dashboard")).body.data;
    const sent = (overview.body.data.items as { purchaseOrders: { sent: number } }[]).reduce((n, i) => n + i.purchaseOrders.sent, 0);
    expect(sent).toBeLessThanOrEqual(dashboard.purchaseOrders.sent); // 등록된 공급처의 발주만 센다
  });
});
