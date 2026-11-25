import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";
import { loadOperations, MISSING, sampleBody, specKey, type Json } from "../helpers/httpContract";

/**
 * `requestSchemaAgreement`는 대상이 없는 요청으로 비교해서, 서버가 대상 조회(404)를 입력 검증보다 먼저 하는 경로에서는
 * 명세가 거부하는 입력을 서버가 정말 400으로 거부하는지 알 수 없었다(판단 불가). 여기서는 **대상이 실제로 존재하는 요청**으로
 * 그 입력들을 다시 보낸다. 거부 입력만 보내므로 서버가 400을 내면 상태가 바뀌지 않는다.
 */
const SECRET = "request-conclusive-secret-0123456789abcdef";
const T = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";
const PAST = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
const call = async (method: "GET" | "POST", fullPath: string, body?: unknown) => {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "POST") headers["idempotency-key"] = `conc-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method, path: `/v1/tenants/${T}${fullPath}`, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
};
const must = async (res: Promise<{ status: number; body: any }>, status: number, what: string) => {
  const r = await res;
  expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body.data;
};

/** 경로의 대상이 실제로 존재하는 세계: 경로 매개변수 이름 → 실제 ID */
type World = Record<string, string>;
async function buildWorld(): Promise<World> {
  const book = await must(call("POST", "/books", { source: "MANUAL", title: "세계 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: PAST }), 201, "도서");
  const order = await must(call("POST", "/orders", { lines: [{ bookId: book.id, quantity: 2, unitPriceKrw: "10000" }] }), 201, "주문");
  const confirmed = await must(call("POST", `/orders/${order.id}/confirm`, { expectedVersion: 1 }), 200, "주문 확정");
  const orderId = order.id as string;
  const lineId = confirmed.lines[0].lineId as string;
  const world: World = { bookId: book.id, orderId, lineId };

  // 재고 → 예약 → 수령(수령 정정의 대상)
  await must(call("POST", `/books/${book.id}/initial-stock`, { quantity: 2, actedAt: PAST }), 201, "초기 재고");
  const reservation = await must(call("POST", `/orders/${orderId}/lines/${lineId}/stock-reservations`, { quantity: 2, reservedAt: PAST }), 201, "예약");
  // 수령은 결제 확인 뒤에만 할 수 있다
  const payment = await must(call("POST", `/orders/${orderId}/payments`, { method: "BANK_TRANSFER", amountKrw: "20000", externalReference: `CONC-${++seq}`, paidAt: PAST }), 201, "결제");
  await must(call("POST", `/payments/${payment.id}/confirmation`, { evidence: "입금 확인", confirmedAt: PAST }), 201, "결제 확인");
  world.paymentId = payment.id;
  const fulfillment = await must(call("POST", `/orders/${orderId}/fulfillments`, { orderLineId: lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }], receivedAt: PAST }), 201, "수령");
  world.fulfillmentId = fulfillment.id;

  const supplierCode = `conc-sup-${++seq}`; // 서점 안에서 유일해야 하므로 호출마다 다르게 한다
  // 공급처 → 배정 → 발주 → 입고(초과 1권) → 배분 (입고 정정·초과 결정·배분 재배분의 대상)
  await must(call("POST", "/suppliers", { code: supplierCode, name: "세계 도매", orderChannel: "EMAIL", registeredAt: PAST }), 201, "공급처");
  const order2 = await must(call("POST", "/orders", { lines: [{ bookId: book.id, quantity: 2, unitPriceKrw: "10000" }] }), 201, "주문 2");
  const confirmed2 = await must(call("POST", `/orders/${order2.id}/confirm`, { expectedVersion: 1 }), 200, "주문 2 확정");
  const line2 = confirmed2.lines[0].lineId as string;
  const sourcing = await must(call("POST", `/orders/${order2.id}/lines/${line2}/sourcing-allocations`, { supplierCode, quantity: 2 }), 201, "배정");
  const po = await must(call("POST", "/purchase-orders", { supplierCode, allocationIds: [sourcing.id] }), 201, "발주");
  await must(call("POST", `/purchase-orders/${po.id}/ready`, { expectedVersion: 1 }), 200, "발주 준비");
  await must(call("POST", `/purchase-orders/${po.id}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: PAST }), 200, "발주 전달");
  const poLineId = (await must(call("GET", `/purchase-orders/${po.id}`), 200, "발주 조회")).lines[0].poLineId as string;
  const receipt = await must(call("POST", `/purchase-orders/${po.id}/receipts`, { poLineId, normalQuantity: 3, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: PAST }), 201, "입고");
  world.purchaseOrderId = po.id;
  world.poLineId = poLineId;
  world.receiptId = receipt.id;
  world.order2Id = order2.id;
  world.line2Id = line2;
  const allocation = await must(call("POST", `/receipts/${receipt.id}/allocations`, { orderId: order2.id, orderLineId: line2, quantity: 2, allocatedAt: PAST }), 201, "배분");
  world.allocationId = allocation.id;

  // 과수납 주문 → 환급 업무 (환급 요청·시도의 대상)
  const order3 = await must(call("POST", "/orders", { lines: [{ bookId: book.id, quantity: 1, unitPriceKrw: "10000" }] }), 201, "주문 3");
  await must(call("POST", `/orders/${order3.id}/confirm`, { expectedVersion: 1 }), 200, "주문 3 확정");
  const overpaid = await must(call("POST", `/orders/${order3.id}/payments`, { method: "BANK_TRANSFER", amountKrw: "15000", externalReference: `CONC-${++seq}`, paidAt: PAST }), 201, "과수납");
  await must(call("POST", `/payments/${overpaid.id}/confirmation`, { evidence: "입금 확인", confirmedAt: PAST }), 201, "과수납 확인");
  const task = await must(call("POST", `/orders/${order3.id}/refund-tasks`, { openedAt: PAST }), 201, "환급 업무");
  world.taskId = task.id;
  world.overpaidPaymentId = overpaid.id;
  return world;
}

describe("판단 불가였던 거부 입력을 대상이 존재하는 요청으로 확인한다", () => {
  it("주문 확정(orders/{orderId}/confirm): expectedVersion 거부 입력 6건을 실제 주문에 보내면 서버가 모두 400이다", async () => {
    const world = await buildWorld();
    const ops = await loadOperations();
    const key = "POST /v1/tenants/{tenantId}/orders/{orderId}/confirm";
    const schema = ops.get(key)!.requestBody.content["application/json"].schema as Json;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const bodies: Record<string, unknown>[] = [0, -1, 1.5, "1", null].map((expectedVersion) => ({ expectedVersion }));
    bodies.push({}); // 필수 필드 누락

    const problems: string[] = [];
    for (const body of bodies) {
      expect(ajv.validate(schema, body), `이 입력은 스키마가 거부해야 한다: ${JSON.stringify(body)}`).toBe(false);
      const { status, body: res } = await call("POST", `/orders/${world.orderId}/confirm`, body);
      if (status !== 400) problems.push(`${JSON.stringify(body)} -> ${status} ${JSON.stringify(res)}`);
    }
    expect(problems).toEqual([]);
    // 거부된 요청은 주문을 바꾸지 않았다
    expect((await must(call("GET", `/orders/${world.orderId}`), 200, "주문 조회")).version).toBe(2);
  });

  it("수령 정정과 초과 입고 결정: 거부 입력을 실제 수령·입고에 보내면 서버가 모두 400이다", async () => {
    const world = await buildWorld();
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v)));
    const check = async (route: string, path: string, base: Record<string, unknown>, mutations: Record<string, unknown[]>) => {
      const schema = ops.get(`POST /v1/tenants/{tenantId}${route}`)!.requestBody.content["application/json"].schema as Json;
      const problems: string[] = [];
      for (const [field, values] of Object.entries(mutations)) {
        for (const value of [...values, "__omit__"]) {
          const body = { ...base };
          if (value === "__omit__") delete body[field];
          else body[field] = value;
          expect(ajv.validate(schema, body), `이 입력은 스키마가 거부해야 한다: ${route} ${field}=${JSON.stringify(value)}`).toBe(false);
          const { status, body: res } = await call("POST", path, body);
          if (status !== 400) problems.push(`${route} .${field}=${JSON.stringify(value)} -> ${status} ${JSON.stringify(res)}`);
        }
      }
      return problems;
    };
    const problems = [
      ...(await check("/orders/{orderId}/fulfillments/{fulfillmentId}/corrections", `/orders/${world.orderId}/fulfillments/${world.fulfillmentId}/corrections`,
        { quantity: 1, restorations: [{ kind: "STOCK_RESERVATION", sourceId: MISSING, quantity: 1 }], reason: "정정", evidence: "증빙", physicalReturnConfirmed: true, correctedAt: PAST },
        { physicalReturnConfirmed: ["true", 1, null] })),
      ...(await check("/receipts/{receiptId}/excess-decisions", `/receipts/${world.receiptId}/excess-decisions`,
        { decision: "APPROVED", quantity: 1, reason: "승인", decidedAt: PAST },
        { decision: ["BOGUS", "", 123, null], decidedAt: ["", 123, null, "not-a-date", "2026-03-04"] })),
    ];
    expect(problems).toEqual([]);
  });

  it("본문의 참조 ID 필드: uuid가 아닌 값·빈 문자열·숫자·null·누락을 실제 대상에 보내면 12개 필드 모두 서버가 400이다", async () => {
    const world = await buildWorld();
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v)));
    ajv.addFormat("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
    const BAD: unknown[] = ["not-a-uuid", "", 123, null, "__omit__"];
    // (경로, 실제 경로, 올바른 기준 본문, 바꿔 볼 참조 필드)
    const targets: [string, string, Record<string, unknown>, string[]][] = [
      ["/orders/{orderId}/cancellation-requests", `/orders/${world.orderId}/cancellation-requests`, { orderLineId: world.lineId, quantity: 1, reason: "r", expectedVersion: 2, requestedAt: PAST }, ["orderLineId"]],
      ["/orders/{orderId}/fulfillments", `/orders/${world.orderId}/fulfillments`, { orderLineId: world.lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: MISSING, quantity: 1 }], receivedAt: PAST }, ["orderLineId"]],
      ["/receipts/{receiptId}/allocations", `/receipts/${world.receiptId}/allocations`, { orderId: world.order2Id, orderLineId: world.line2Id, quantity: 1, allocatedAt: PAST }, ["orderId", "orderLineId"]],
      ["/allocations/{allocationId}/reallocations", `/allocations/${world.allocationId}/reallocations`, { toOrderId: world.order2Id, toOrderLineId: world.line2Id, quantity: 1, reason: "r", actedAt: PAST }, ["toOrderId", "toOrderLineId"]],
      ["/refund-tasks/{taskId}/refund-requests", `/refund-tasks/${world.taskId}/refund-requests`, { paymentId: world.overpaidPaymentId, amountKrw: "1000", evidence: "e", requestedAt: PAST }, ["paymentId"]],
      ["/refund-tasks/{taskId}/refund-attempts", `/refund-tasks/${world.taskId}/refund-attempts`, { paymentId: world.overpaidPaymentId, amountKrw: "1000", result: "FAILED", reason: "r", reportedAt: PAST }, ["paymentId"]],
      ["/orders/{orderId}/lines/{lineId}/duplicate-risk-approvals", `/orders/${world.orderId}/lines/${world.lineId}/duplicate-risk-approvals`, { purchaseOrderId: world.purchaseOrderId, poLineId: world.poLineId, surplusPlan: "STOCK_INTAKE", planNote: "n", approvedAt: PAST }, ["purchaseOrderId", "poLineId"]],
      ["/purchase-orders/{purchaseOrderId}/receipts", `/purchase-orders/${world.purchaseOrderId}/receipts`, { poLineId: world.poLineId, normalQuantity: 1, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: PAST }, ["poLineId"]],
      ["/purchase-orders/{purchaseOrderId}/supplier-replies", `/purchase-orders/${world.purchaseOrderId}/supplier-replies`, { poLineId: world.poLineId, kind: "CONFIRM", quantity: 1, evidence: "e", repliedAt: PAST }, ["poLineId"]],
      ["/books/{bookId}/updates", `/books/${world.bookId}/updates`, { expectedVersion: 1, changes: { title: "새 제목" }, reason: "r", changedAt: PAST }, ["acknowledgeDuplicateOf"]],
    ];
    const problems: string[] = [];
    const observed: Record<string, Record<string, number>> = {};
    let checked = 0;
    for (const [route, path, base, fields] of targets) {
      const schema = ops.get(`POST /v1/tenants/{tenantId}${route}`)!.requestBody.content["application/json"].schema as Json;
      expect(ajv.validate(schema, base), `기준 본문이 스키마를 만족해야 한다: ${route} ${ajv.errorsText()}`).toBe(true);
      for (const field of fields) {
        for (const value of BAD) {
          // acknowledgeDuplicateOf는 선택 필드라 누락이 거부가 아니다
          if (value === "__omit__" && !(schema.required ?? []).includes(field)) continue;
          const body: Record<string, unknown> = { ...base };
          if (value === "__omit__") delete body[field];
          else body[field] = value;
          if (ajv.validate(schema, body)) continue; // 스키마도 받아들이는 입력은 이 테스트의 대상이 아니다
          checked++;
          const { status } = await call("POST", path, body);
          const kind = value === "__omit__" ? "누락" : value === null ? "null" : typeof value === "number" ? "숫자" : value === "" ? "빈 문자열" : "uuid 아님";
          observed[`${route} .${field}`] = { ...(observed[`${route} .${field}`] ?? {}), [kind]: status };
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    // 모든 (경로, 필드)가 모든 값 종류에서 400이다. 하나라도 400이 아니면 그 필드·값이 실패 메시지에 나온다
    const everyKind = { "uuid 아님": 400, "빈 문자열": 400, "숫자": 400, null: 400 };
    const expected = Object.fromEntries(Object.entries(observed).map(([key, kinds]) => [key, { ...everyKind, ...("누락" in kinds ? { "누락": 400 } : {}) }]));
    expect(observed).toEqual(expected);
    expect(Object.keys(observed).length).toBeGreaterThanOrEqual(12);
  });

  it("발주 생성의 allocationIds: 원소가 uuid가 아니거나 비어 있지 않은 문자열이 아니거나 배열이 아니거나 비어 있거나 중복이면 실제 배정이 있어도 서버가 모두 400이다", async () => {
    const world = await buildWorld();
    const ops = await loadOperations();
    const schema = ops.get("POST /v1/tenants/{tenantId}/purchase-orders")!.requestBody.content["application/json"].schema as Json;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
    // 유효한 배정을 하나 만들고, 그 배정을 섞은 잘못된 입력을 보낸다
    const lineOf = async () => {
      const order = await must(call("POST", "/orders", { lines: [{ bookId: world.bookId, quantity: 1, unitPriceKrw: "10000" }] }), 201, "주문");
      const confirmed = await must(call("POST", `/orders/${order.id}/confirm`, { expectedVersion: 1 }), 200, "확정");
      return { orderId: order.id as string, lineId: confirmed.lines[0].lineId as string };
    };
    const line = await lineOf();
    const supplier = `conc-po-${++seq}`;
    await must(call("POST", "/suppliers", { code: supplier, name: "발주 도매", orderChannel: "EMAIL", registeredAt: PAST }), 201, "공급처");
    const allocation = await must(call("POST", `/orders/${line.orderId}/lines/${line.lineId}/sourcing-allocations`, { supplierCode: supplier, quantity: 1 }), 201, "배정");

    const cases: [string, unknown][] = [
      ["uuid 아닌 원소 하나", ["not-a-uuid"]],
      ["유효 + uuid 아님", [allocation.id, "not-a-uuid"]],
      ["유효 + 빈 문자열", [allocation.id, ""]],
      ["유효 + 숫자", [allocation.id, 123]],
      ["유효 + null", [allocation.id, null]],
      ["빈 배열", []],
      ["배열이 아님", "x"],
      ["null", null],
      ["중복 원소", [allocation.id, allocation.id]],
    ];
    const problems: string[] = [];
    for (const [label, ids] of cases) {
      const body = { supplierCode: supplier, allocationIds: ids };
      expect(ajv.validate(schema, body), `이 입력은 스키마가 거부해야 한다: ${label}`).toBe(false);
      const { status } = await call("POST", "/purchase-orders", body);
      if (status !== 400) problems.push(`${label} -> ${status}`);
    }
    expect(problems).toEqual([]);
    // 거부된 요청이 배정을 소모하지 않았다: 유효한 입력은 만들어진다
    expect((await call("POST", "/purchase-orders", { supplierCode: supplier, allocationIds: [allocation.id] })).status).toBe(201);
  });
});

