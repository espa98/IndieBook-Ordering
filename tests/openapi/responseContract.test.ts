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

/** 명세의 `GET <template>` 200 응답 스키마(참조를 풀지 않은 원본)를 찾는다 */
const responseSchema = (template: string) => spec.paths[`/v1/tenants/{tenantId}${template}`].get.responses["200"].content["application/json"].schema as Record<string, any>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("date-time", (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)));
ajv.addFormat("date", (v) => /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v)));
ajv.addFormat("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
const conforms = (template: string, body: unknown) => {
  const schema = { ...responseSchema(template), components: spec.components };
  const ok = ajv.validate(schema, body);
  return { ok, errors: ajv.errorsText() };
};
const declared = (template: string) => Object.keys(responseSchema(template).properties?.data ?? {}).length > 0;

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

