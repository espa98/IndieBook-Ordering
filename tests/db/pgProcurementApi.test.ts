import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCancellationApi } from "../../src/db/pgCancellationApi";
import { createPgDispositionApi } from "../../src/db/pgDispositionApi";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgProcurementApi } from "../../src/db/pgProcurementApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER_A]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T_A, OWNER_A, STAFF_A, EX_STAFF_A]);
  await c.query(
    `insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel, version) values ($1, 'sup-a', true, '공급처 A', 'EMAIL', 1), ($1, 'sup-b', true, '공급처 B', 'EMAIL', 1), ($1, 'sup-off', false, '중단 공급처', 'EMAIL', 1)`,
    [T_A],
  );
  for (let n = 1; n <= 20; n++) {
    await c.query(
      `insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, $3, 10000, 'MANUAL', '시험', 'seed', now())`,
      [BOOK(n), T_A, `책 ${n}`],
    );
  }
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const staff = { userId: STAFF_A };
let seq = 0;
const key = () => `p-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};

/** 확정 주문(품목 1개)과 그 품목에 대한 조달 배정(ACTIVE)을 만든다 */
async function sourced(book: number, quantity: number, supplier = "sup-a") {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  const allocationId = (
    await rows(`insert into public.ordering_sourcing_allocations (tenant_id, order_id, order_line_id, supplier_code, quantity) values ($1, $2, $3, $4, $5) returning id`, [T_A, order.id, lineId, supplier, quantity])
  )[0].id as string;
  return { orderId: order.id, lineId, allocationId };
}
const create = (api: ReturnType<typeof createPgProcurementApi>, supplierCode: string, allocationIds: string[], actor = staff) =>
  api.createPurchaseOrder(actor, { tenantId: T_A, supplierCode, allocationIds, idempotencyKey: key() });

describe("발주 생성 (Postgres 영속화)", () => {
  it("배정 수량으로 발주 초안(품목·주문 연결 포함)을 저장하고, 중복 연결·다른 공급처·중단·없는 공급처·비멤버는 거부된다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const a = await sourced(1, 2);
    const b = await sourced(1, 3); // 같은 도서의 다른 주문: 발주 품목 하나로 합산된다

    const po = await create(api, "sup-a", [a.allocationId, b.allocationId]);

    expect(po).toMatchObject({ status: "DRAFT", version: 1, supplierCode: "sup-a" });
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0]).toMatchObject({ bookId: BOOK(1), quantity: 5 });
    expect(po.lines[0]!.links.map((l) => l.allocationId).sort()).toEqual([a.allocationId, b.allocationId].sort());
    expect((await rows("select status, version::int as version from public.ordering_purchase_orders where id = $1", [po.id]))[0]).toEqual({ status: "DRAFT", version: 1 });
    expect((await rows("select quantity::int as n from public.ordering_po_lines where purchase_order_id = $1", [po.id]))[0].n).toBe(5);
    expect((await rows("select count(*)::int as n from public.ordering_po_links where po_line_id = $1", [po.lines[0]!.poLineId]))[0].n).toBe(2);

    expect(await codeOf(() => create(api, "sup-a", [a.allocationId]))).toBe("BUSINESS_INVARIANT"); // 이미 발주에 연결됨
    const other = await sourced(2, 1, "sup-b");
    expect(await codeOf(() => create(api, "sup-a", [other.allocationId]))).toBe("BUSINESS_INVARIANT"); // 다른 공급처 배정
    const off = await sourced(3, 1, "sup-off");
    expect(await codeOf(() => create(api, "sup-off", [off.allocationId]))).toBe("BUSINESS_INVARIANT"); // 중단된 공급처
    expect(await codeOf(() => create(api, "sup-none", [other.allocationId]))).toBe("NOT_FOUND");
    expect(await codeOf(() => create(api, "sup-b", ["0a000000-0000-4000-8000-00000000ffff"]))).toBe("NOT_FOUND");
    expect(await codeOf(() => create(api, "sup-b", [other.allocationId], { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => create(api, "sup-b", [other.allocationId], { userId: EX_STAFF_A }))).toBe("FORBIDDEN");
    expect((await create(api, "sup-b", [other.allocationId])).status).toBe("DRAFT"); // 거부된 시도는 배정을 소비하지 않았다
  });
});

type Api = ReturnType<typeof createPgProcurementApi>;
const ready = (api: Api, purchaseOrderId: string, expectedVersion: number, actor = staff) => api.markPurchaseOrderReady(actor, { tenantId: T_A, purchaseOrderId, expectedVersion, idempotencyKey: key() });
const deliver = (api: Api, purchaseOrderId: string, expectedVersion: number, actor = staff) =>
  api.recordPurchaseOrderDelivery(actor, { tenantId: T_A, purchaseOrderId, expectedVersion, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z", referenceNumber: "MAIL-1", idempotencyKey: key() });
const supplierReply = (api: Api, purchaseOrderId: string, poLineId: string, kind: "CONFIRM" | "OUT_OF_STOCK" | "DELAY", quantity: number, extra: { eta?: string } = {}) =>
  api.recordSupplierReply(staff, { tenantId: T_A, purchaseOrderId, poLineId, kind, quantity, evidence: "공급처 회신 메일", repliedAt: "2026-03-04T06:20:00.000Z", ...extra, idempotencyKey: key() });
const poRow = async (id: string) => (await rows("select status, version::int as version, delivery from public.ordering_purchase_orders where id = $1", [id]))[0];

describe("발주 전달 준비·전달 기록·공급처 회신 (Postgres 영속화)", () => {
  it("초안 → 전달 준비 → 전달 기록(SENT) → 첫 회신(ACKNOWLEDGED)으로 이어지고, 낡은 version·상태 위반·수량 초과·없는 품목은 거부되며, 이후 입고가 이어진다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const a = await sourced(4, 2);
    const po = await create(api, "sup-a", [a.allocationId]);
    const poLineId = po.lines[0]!.poLineId;

    expect(await codeOf(() => deliver(api, po.id, 1))).toBe("BUSINESS_INVARIANT"); // 아직 DRAFT
    expect(await codeOf(() => supplierReply(api, po.id, poLineId, "CONFIRM", 1))).toBe("BUSINESS_INVARIANT"); // 아직 전달 전
    expect(await codeOf(() => ready(api, po.id, 9))).toBe("VERSION_CONFLICT");
    expect(await codeOf(() => ready(api, po.id, 1, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => ready(api, "0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    expect(await ready(api, po.id, 1)).toMatchObject({ status: "READY", version: 2 });
    expect(await codeOf(() => ready(api, po.id, 2))).toBe("BUSINESS_INVARIANT"); // 이미 READY

    expect(await codeOf(() => deliver(api, po.id, 1))).toBe("VERSION_CONFLICT");
    const sent = await deliver(api, po.id, 2);
    expect(sent).toMatchObject({ status: "SENT", version: 3 });
    expect(sent.delivery).toMatchObject({ method: "EMAIL", deliveredBy: STAFF_A, referenceNumber: "MAIL-1", poVersion: 2 });
    expect(await poRow(po.id)).toMatchObject({ status: "SENT", version: 3 });
    expect((await poRow(po.id)).delivery).toMatchObject({ deliveredBy: STAFF_A });

    expect(await codeOf(() => supplierReply(api, po.id, "0a000000-0000-4000-8000-00000000ffff", "CONFIRM", 1))).toBe("NOT_FOUND");
    expect(await codeOf(() => supplierReply(api, po.id, poLineId, "CONFIRM", 3))).toBe("BUSINESS_INVARIANT"); // 발주 2권 초과
    const confirm = await supplierReply(api, po.id, poLineId, "CONFIRM", 2);
    expect(confirm).toMatchObject({ kind: "CONFIRM", quantity: 2 });
    expect(await poRow(po.id)).toMatchObject({ status: "ACKNOWLEDGED", version: 4 });
    expect((await rows("select count(*)::int as n from public.ordering_po_replies where purchase_order_id = $1", [po.id]))[0].n).toBe(1);

    // 영속화한 발주 위에서 입고·배분이 그대로 이어진다
    const receiving = createPgReceivingApi({ pool: db.pool() });
    const receipt = await receiving.receiveGoods(staff, { tenantId: T_A, purchaseOrderId: po.id, poLineId, normalQuantity: 2, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() });
    const allocation = await receiving.allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: a.orderId, orderLineId: a.lineId, quantity: 2, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });
    expect(allocation.quantity).toBe(2);
  });
});

const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();

describe("발주의 실제 동시성과 DB 방어 (두 독립 세션)", () => {
  it("같은 배정으로 두 세션이 동시에 발주를 만들면 하나만 성공하고, 같은 발주를 동시에 전달 준비해도 한 번만 전이한다", async () => {
    const a = await sourced(5, 2);
    const created = await Promise.allSettled([create(createPgProcurementApi({ pool: db.pool() }), "sup-a", [a.allocationId]), create(createPgProcurementApi({ pool: db.pool() }), "sup-a", [a.allocationId])]);
    expect(outcomes(created)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect((await rows("select count(*)::int as n from public.ordering_po_links where allocation_id = $1", [a.allocationId]))[0].n).toBe(1);

    const po = (created.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value;
    const readied = await Promise.allSettled([ready(createPgProcurementApi({ pool: db.pool() }), po.id, 1), ready(createPgProcurementApi({ pool: db.pool() }), po.id, 1)]);
    expect(outcomes(readied)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect((await poRow(po.id)).version).toBe(2);
  });

  it("발주 3권에 두 세션이 동시에 2권씩 확정 회신해도 발주량을 넘기지 못한다", async () => {
    const a = await sourced(6, 3);
    const api = createPgProcurementApi({ pool: db.pool() });
    const po = await create(api, "sup-a", [a.allocationId]);
    await ready(api, po.id, 1);
    await deliver(api, po.id, 2);

    const results = await Promise.allSettled([
      supplierReply(createPgProcurementApi({ pool: db.pool() }), po.id, po.lines[0]!.poLineId, "CONFIRM", 2),
      supplierReply(createPgProcurementApi({ pool: db.pool() }), po.id, po.lines[0]!.poLineId, "CONFIRM", 2),
    ]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect((await rows("select coalesce(sum(quantity), 0)::int as n from public.ordering_po_replies where purchase_order_id = $1", [po.id]))[0].n).toBe(2);
    expect((await poRow(po.id)).version).toBe(4); // 첫 회신만 SENT를 ACKNOWLEDGED로 바꾼다
  });

  it("직접 SQL로도 발주 상태를 건너뛰거나 version을 건너뛰거나 공급처를 바꾸거나 전달 전 발주에 회신을 넣을 수 없다", async () => {
    const a = await sourced(7, 2);
    const api = createPgProcurementApi({ pool: db.pool() });
    const po = await create(api, "sup-a", [a.allocationId]);
    const poLineId = po.lines[0]!.poLineId;
    const c = await db.connect();
    const q = (sql: string) => () => c.query(sql);
    try {
      expect(await sqlState(q(`update public.ordering_purchase_orders set status = 'SENT', version = 2 where id = '${po.id}'`))).toBe("P0001"); // DRAFT -> SENT 건너뜀
      expect(await sqlState(q(`update public.ordering_purchase_orders set status = 'READY', version = 3 where id = '${po.id}'`))).toBe("P0001"); // version 건너뜀
      expect(await sqlState(q(`update public.ordering_purchase_orders set supplier_code = 'sup-b' where id = '${po.id}'`))).toBe("P0001");
      expect(await sqlState(q(`insert into public.ordering_po_replies (tenant_id, purchase_order_id, po_line_id, kind, quantity, evidence, replied_at) values ('${T_A}', '${po.id}', '${poLineId}', 'CONFIRM', 1, '근거', now())`))).toBe("P0001"); // 전달 전
      expect(await sqlState(q(`update public.ordering_po_lines set quantity = 9 where id = '${poLineId}'`))).toBe("P0001"); // 추가 전용
      await c.query(`update public.ordering_purchase_orders set status = 'READY', version = 2 where id = '${po.id}'`); // 정상 전이는 가능
    } finally {
      await c.end();
    }
  });
});

async function confirmedLine(book: number, quantity: number) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  return { orderId: order.id, lineId: order.lines[0]!.lineId };
}
const allocate = (api: Api, line: { orderId: string; lineId: string }, supplierCode: string, quantity: number, actor = staff) =>
  api.allocateSourcing(actor, { tenantId: T_A, orderId: line.orderId, lineId: line.lineId, supplierCode, quantity, idempotencyKey: key() });
const release = (api: Api, allocationId: string, actor = staff) =>
  api.releaseSourcing(actor, { tenantId: T_A, allocationId, reason: "공급처 변경", releasedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });

describe("조달 배정·해제 (Postgres 영속화)", () => {
  it("주문 품목 수량 한도 안에서 배정하고, 한도 초과·중단·없는 공급처·없는 주문·종결 주문·비멤버는 거부된다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const line = await confirmedLine(8, 3);

    const first = await allocate(api, line, "sup-a", 2);
    expect(first).toMatchObject({ orderId: line.orderId, lineId: line.lineId, supplierCode: "sup-a", quantity: 2, status: "ACTIVE" });
    expect((await rows("select status, quantity::int as quantity from public.ordering_sourcing_allocations where id = $1", [first.id]))[0]).toEqual({ status: "ACTIVE", quantity: 2 });
    expect(await codeOf(() => allocate(api, line, "sup-b", 2))).toBe("BUSINESS_INVARIANT"); // 활성 배정 2 + 2 > 3
    expect((await allocate(api, line, "sup-b", 1)).quantity).toBe(1);
    expect(await codeOf(() => allocate(api, line, "sup-off", 1))).toBe("BUSINESS_INVARIANT"); // 중단된 공급처(한도 이전에 거부)
    expect(await codeOf(() => allocate(api, line, "sup-none", 1))).toBe("NOT_FOUND");
    expect(await codeOf(() => allocate(api, { orderId: "0a000000-0000-4000-8000-00000000ffff", lineId: line.lineId }, "sup-a", 1))).toBe("NOT_FOUND");
    expect(await codeOf(() => allocate(api, line, "sup-a", 1, { userId: STRANGER }))).toBe("FORBIDDEN");

    const closed = await confirmedLine(9, 1);
    await rows("update public.ordering_orders set closed_at = now(), version = version + 1 where id = $1", [closed.orderId]);
    expect(await codeOf(() => allocate(api, closed, "sup-a", 1))).toBe("BUSINESS_INVARIANT");
  });

  it("미전달 발주에 연결된 배정은 해제할 수 없고, 전달된 발주에 연결된 배정은 발주를 바꾸지 않고 남는 의무를 기록하며 해제된다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const line = await confirmedLine(10, 2);
    const allocation = await allocate(api, line, "sup-a", 2);
    const po = await create(api, "sup-a", [allocation.id]);

    expect(await codeOf(() => release(api, allocation.id))).toBe("BUSINESS_INVARIANT"); // 미전달 발주를 먼저 취소해야 한다
    expect(await codeOf(() => release(api, "0a000000-0000-4000-8000-00000000ffff"))).toBe("NOT_FOUND");
    await ready(api, po.id, 1);
    await deliver(api, po.id, 2);

    const released = await release(api, allocation.id);
    expect(released).toMatchObject({ allocationId: allocation.id, quantity: 2, releasedBy: STAFF_A, retainedObligations: [{ purchaseOrderId: po.id, poLineId: po.lines[0]!.poLineId, quantity: 2 }] });
    expect((await rows("select status from public.ordering_sourcing_allocations where id = $1", [allocation.id]))[0].status).toBe("RELEASED");
    expect(await poRow(po.id)).toMatchObject({ status: "SENT", version: 3 }); // 이미 전달된 발주는 그대로다
    expect((await rows("select count(*)::int as n from public.ordering_sourcing_releases where allocation_id = $1", [allocation.id]))[0].n).toBe(1);
    expect(await codeOf(() => release(api, allocation.id))).toBe("BUSINESS_INVARIANT"); // 이미 해제됨
    expect(await codeOf(() => allocate(api, line, "sup-b", 2))).toBe("BUSINESS_INVARIANT"); // 한도는 풀렸지만 남은 의무 때문에 중복 위험 승인이 필요하다 (BR-P05)
    await approveRisk(api, line, { purchaseOrderId: po.id, poLineId: po.lines[0]!.poLineId });
    expect((await allocate(api, line, "sup-b", 2)).status).toBe("ACTIVE"); // 해제로 한도가 풀렸다

    const lone = await allocate(api, await confirmedLine(11, 1), "sup-a", 1);
    expect((await release(api, lone.id)).retainedObligations).toEqual([]); // 발주에 연결되지 않은 배정
  });
});

const approveRisk = (api: Api, line: { orderId: string; lineId: string }, obligation: { purchaseOrderId: string; poLineId: string }, actor = owner) =>
  api.approveDuplicateRisk(actor, { tenantId: T_A, orderId: line.orderId, lineId: line.lineId, ...obligation, surplusPlan: "STOCK_INTAKE", planNote: "남는 물량은 재고로 편입", approvedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });

describe("중복 구매 위험 (이전 공급처 의무가 남은 품목의 재조달, BR-P05)", () => {
  it("배정을 풀었지만 공급처 의무가 남은 품목은 Owner의 승인 뒤에만 다른 공급처로 재조달되고, 의무가 사라지면 승인 없이도 가능하다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const line = await confirmedLine(16, 2);
    const first = await allocate(api, line, "sup-a", 2);
    const po = await create(api, "sup-a", [first.id]);
    await ready(api, po.id, 1);
    await deliver(api, po.id, 2);
    await release(api, first.id); // 발주는 이미 전달되어 공급처 의무 2권이 남는다
    const obligation = { purchaseOrderId: po.id, poLineId: po.lines[0]!.poLineId };

    expect(await codeOf(() => allocate(api, line, "sup-b", 2))).toBe("BUSINESS_INVARIANT"); // 중복 위험 승인 필요
    expect(await codeOf(() => approveRisk(api, line, obligation, staff))).toBe("FORBIDDEN"); // Owner만
    expect(await codeOf(() => approveRisk(api, line, { ...obligation, poLineId: "0a000000-0000-4000-8000-00000000ffff" }))).toBe("BUSINESS_INVARIANT"); // 열린 의무가 없는 승인
    const approval = await approveRisk(api, line, obligation);
    expect(approval).toMatchObject({ orderId: line.orderId, lineId: line.lineId, ...obligation, surplusPlan: "STOCK_INTAKE", approvedBy: OWNER_A });
    expect((await rows("select count(*)::int as n from public.ordering_duplicate_risk_approvals where order_id = $1", [line.orderId]))[0].n).toBe(1);
    expect((await allocate(api, line, "sup-b", 2)).status).toBe("ACTIVE"); // 승인 뒤에는 재조달할 수 있다

    // 공급처가 전량 품절을 확정하면 의무가 사라져 승인 없이도 재조달할 수 있다
    const other = await confirmedLine(17, 2);
    const second = await allocate(api, other, "sup-a", 2);
    const po2 = await create(api, "sup-a", [second.id]);
    await ready(api, po2.id, 1);
    await deliver(api, po2.id, 2);
    await release(api, second.id);
    expect(await codeOf(() => allocate(api, other, "sup-b", 2))).toBe("BUSINESS_INVARIANT");
    await api.recordSupplierReply(staff, { tenantId: T_A, purchaseOrderId: po2.id, poLineId: po2.lines[0]!.poLineId, kind: "OUT_OF_STOCK", quantity: 2, source: "UNANSWERED", evidence: "공급처 품절 회신", repliedAt: "2026-03-04T06:20:00.000Z", idempotencyKey: key() });
    expect((await allocate(api, other, "sup-b", 2)).status).toBe("ACTIVE");
  });
});

const cancelUndelivered = (api: Api, purchaseOrderId: string, expectedVersion: number, actor = staff) =>
  api.cancelUndeliveredPurchaseOrder(actor, { tenantId: T_A, purchaseOrderId, expectedVersion, reason: "공급처 변경", cancelledAt: "2026-03-04T06:15:00.000Z", idempotencyKey: key() });
const requestCancel = (api: Api, purchaseOrderId: string, poLineId: string, quantity: number) =>
  api.createCancellationRequest(staff, { tenantId: T_A, purchaseOrderId, poLineId, quantity, reason: "고객 취소로 물량 축소", idempotencyKey: key() });
const respondCancel = (api: Api, purchaseOrderId: string, cancellationRequestId: string, acceptedQuantity: number, rejectedQuantity: number) =>
  api.respondToCancellationRequest(staff, { tenantId: T_A, purchaseOrderId, cancellationRequestId, acceptedQuantity, rejectedQuantity, evidence: "공급처 취소 회신 메일", repliedAt: "2026-03-04T06:25:00.000Z", idempotencyKey: key() });
const confirmCancel = (api: Api, purchaseOrderId: string, expectedVersion: number) =>
  api.confirmPurchaseOrderCancellation(staff, { tenantId: T_A, purchaseOrderId, expectedVersion, idempotencyKey: key() });
/** 배정 → 발주 → 전달까지 마친 발주 (SENT, version 3) */
async function sentPo(book: number, quantity: number, api: Api) {
  const line = await confirmedLine(book, quantity);
  const allocation = await allocate(api, line, "sup-a", quantity);
  const po = await create(api, "sup-a", [allocation.id]);
  await ready(api, po.id, 1);
  await deliver(api, po.id, 2);
  return { line, allocation, po, poLineId: po.lines[0]!.poLineId };
}

describe("발주 취소 (미전달 취소, 공급처 취소 요청·응답·확정)", () => {
  it("전달하지 않은 발주는 공급처 수락 없이 취소되고 연결됐던 배정은 해제하거나 새 발주에 다시 연결할 수 있으며, 전달된 발주·낡은 version은 거부된다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const line = await confirmedLine(18, 2);
    const allocation = await allocate(api, line, "sup-a", 2);
    const po = await create(api, "sup-a", [allocation.id]);

    expect(await codeOf(() => cancelUndelivered(api, po.id, 9))).toBe("VERSION_CONFLICT");
    expect(await codeOf(() => cancelUndelivered(api, po.id, 1, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => cancelUndelivered(api, "0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    const cancelled = await cancelUndelivered(api, po.id, 1);
    expect(cancelled).toMatchObject({ status: "CANCELLED", version: 2, cancelledBy: STAFF_A, cancelReason: "공급처 변경" });
    expect((await rows("select status, cancelled_by, cancel_reason, cancelled_at is not null as has_time from public.ordering_purchase_orders where id = $1", [po.id]))[0]).toEqual({ status: "CANCELLED", cancelled_by: STAFF_A, cancel_reason: "공급처 변경", has_time: true });
    expect(await codeOf(() => cancelUndelivered(api, po.id, 2))).toBe("BUSINESS_INVARIANT"); // 이미 취소됨

    const again = await create(api, "sup-a", [allocation.id]); // 취소된 발주의 배정은 새 발주에 다시 연결된다
    expect(again.status).toBe("DRAFT");
    await cancelUndelivered(api, again.id, 1);
    expect((await release(api, allocation.id)).retainedObligations).toEqual([]); // 취소된 발주에는 남는 의무가 없다

    const sent = await sentPo(19, 1, api);
    expect(await codeOf(() => cancelUndelivered(api, sent.po.id, 3))).toBe("BUSINESS_INVARIANT"); // 전달된 발주는 공급처 취소 흐름으로만 취소한다
  });

  it("전달된 발주의 취소는 요청 → 공급처 응답(수락·거절) → 전량 수락 확정 순으로만 이루어지고 요청·응답 수량 불변식이 지켜진다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const { po, poLineId } = await sentPo(20, 3, api);
    const draftLine = await confirmedLine(1, 1);
    const draftPo = await create(api, "sup-a", [(await allocate(api, draftLine, "sup-a", 1)).id]);

    expect(await codeOf(() => requestCancel(api, draftPo.id, draftPo.lines[0]!.poLineId, 1))).toBe("BUSINESS_INVARIANT"); // 전달 전 발주
    expect(await codeOf(() => requestCancel(api, po.id, "0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    const first = await requestCancel(api, po.id, poLineId, 2);
    expect(first).toMatchObject({ purchaseOrderId: po.id, poLineId, quantity: 2 });
    expect(await codeOf(() => requestCancel(api, po.id, poLineId, 2))).toBe("BUSINESS_INVARIANT"); // 발주 3권 중 미응답 2권을 빼면 1권만 요청 가능
    expect((await poRow(po.id)).version).toBe(3); // 요청은 발주를 바꾸지 않는다

    expect(await codeOf(() => respondCancel(api, po.id, first.id, 2, 1))).toBe("BUSINESS_INVARIANT"); // 요청 2권 초과
    expect(await codeOf(() => respondCancel(api, po.id, "0a000000-0000-4000-8000-00000000ffff", 1, 0))).toBe("NOT_FOUND");
    const answered = await respondCancel(api, po.id, first.id, 1, 1);
    expect(answered).toMatchObject({ requestId: first.id, acceptedQuantity: 1, rejectedQuantity: 1 });
    expect((await poRow(po.id)).version).toBe(3); // 응답도 발주 상태를 바꾸지 않는다
    expect(await codeOf(() => confirmCancel(api, po.id, 3))).toBe("BUSINESS_INVARIANT"); // 유효 발주량이 아직 2권 남았다

    const second = await requestCancel(api, po.id, poLineId, 2); // 거절된 수량은 다시 요청할 수 있다
    await respondCancel(api, po.id, second.id, 2, 0);
    expect(await codeOf(() => confirmCancel(api, po.id, 9))).toBe("VERSION_CONFLICT");
    expect(await confirmCancel(api, po.id, 3)).toMatchObject({ status: "CANCELLED", version: 4 });
    expect((await rows("select cancelled_at is not null as has_time from public.ordering_purchase_orders where id = $1", [po.id]))[0].has_time).toBe(true);
    expect(await codeOf(() => requestCancel(api, po.id, poLineId, 1))).toBe("BUSINESS_INVARIANT"); // 취소된 발주
  });
});

const closePo = (api: Api, purchaseOrderId: string, expectedVersion: number) =>
  api.executePurchaseOrderClosure({ tenantId: T_A, purchaseOrderId, expectedVersion, executedAt: "2026-03-04T08:00:00.000Z", idempotencyKey: key() });
const blockersOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? `${error.code}:${error.detail ?? ""}` : `NON_APP_ERROR:${(error as Error).message}`;
  }
  return "OK";
};
const receiveAll = (po: { id: string }, poLineId: string, quantity: number) =>
  createPgReceivingApi({ pool: db.pool() }).receiveGoods(staff, { tenantId: T_A, purchaseOrderId: po.id, poLineId, normalQuantity: quantity, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() });

describe("발주 종결 실행 (서버 전용, ST-P11)", () => {
  it("모든 품목이 입고되고 취소 요청이 모두 응답되면 서버가 재계산해 종결하고, 종결된 발주에는 새 입고·회신이 막힌다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const { po, poLineId } = await sentPo(5, 3, api);

    expect(await blockersOf(() => closePo(api, po.id, 3))).toContain("OPEN_QUANTITY"); // 아직 입고 전
    expect(await codeOf(() => closePo(api, "0a000000-0000-4000-8000-00000000ffff", 3))).toBe("NOT_FOUND");
    await receiveAll(po, poLineId, 3);
    const request = await requestCancel(api, po.id, poLineId, 1); // 입고가 끝나도 응답 없는 취소 요청이 있으면 종결할 수 없다
    expect(await blockersOf(() => closePo(api, po.id, 3))).toContain("CANCELLATION_REQUEST_OPEN");
    await respondCancel(api, po.id, request.id, 0, 1);

    expect(await codeOf(() => closePo(api, po.id, 9))).toBe("VERSION_CONFLICT");
    const closed = await closePo(api, po.id, 3);
    expect(closed).toMatchObject({ status: "CLOSED", version: 4 });
    expect((await rows("select status, closed_at is not null as has_time from public.ordering_purchase_orders where id = $1", [po.id]))[0]).toEqual({ status: "CLOSED", has_time: true });

    expect(await codeOf(() => closePo(api, po.id, 4))).toBe("BUSINESS_INVARIANT"); // 이미 종결됨
    expect(await codeOf(() => receiveAll(po, poLineId, 1))).toBe("BUSINESS_INVARIANT"); // 종결된 발주는 입고를 받지 않는다
    expect(await codeOf(() => supplierReply(api, po.id, poLineId, "CONFIRM", 1))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => requestCancel(api, po.id, poLineId, 1))).toBe("BUSINESS_INVARIANT");
  });

  it("주문 취소로 풀린 입고 배분의 처분이 끝나지 않았으면 DISPOSITION_OPEN으로 차단되고, 재고 편입이 기록되면 종결된다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const { line, po, poLineId } = await sentPo(6, 2, api);
    await rows(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', 1, '초기 재고', 'seed', now())`, [T_A, BOOK(6)]);
    const receipt = await receiveAll(po, poLineId, 2);
    await createPgReceivingApi({ pool: db.pool() }).allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: line.orderId, orderLineId: line.lineId, quantity: 2, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });
    const cancel = await createPgFulfillmentApi({ pool: db.pool() }).requestOrderCancellation(staff, { tenantId: T_A, orderId: line.orderId, orderLineId: line.lineId, quantity: 2, reason: "고객 취소", expectedVersion: 2, requestedAt: "2026-03-04T06:45:00.000Z", idempotencyKey: key() });
    const cancellations = createPgCancellationApi({ pool: db.pool() });
    await cancellations.decideOrderCancellation(owner, { tenantId: T_A, requestId: cancel.id, decision: "APPROVED", decidedAt: "2026-03-04T06:47:00.000Z", idempotencyKey: key() });
    await cancellations.applyOrderCancellation(owner, { tenantId: T_A, requestId: cancel.id, appliedAt: "2026-03-04T06:49:00.000Z", idempotencyKey: key() });

    expect(await blockersOf(() => closePo(api, po.id, 3))).toContain("DISPOSITION_OPEN");
    const cancellationId = (await rows("select id from public.ordering_allocation_cancellations where order_id = $1", [line.orderId]))[0].id as string;
    await createPgDispositionApi({ pool: db.pool() }).transferCancelledToStock(owner, { tenantId: T_A, cancellationId, quantity: 2, actedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() });
    expect((await closePo(api, po.id, 3)).status).toBe("CLOSED");
  });
});

describe("발주 종결의 실제 동시성 (두 독립 세션)", () => {
  it("마지막 1권의 입고와 종결 실행이 동시에 들어와도 일관된 결과 하나만 나온다 (입고가 먼저면 종결되고, 종결이 먼저면 입고가 거부된다)", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const { po, poLineId } = await sentPo(7, 2, api);
    await receiveAll(po, poLineId, 1);

    const results = await Promise.allSettled([closePo(createPgProcurementApi({ pool: db.pool() }), po.id, 3), receiveAll(po, poLineId, 1)]);

    const status = (await poRow(po.id)).status as string;
    const received = (await rows("select coalesce(sum(normal_quantity), 0)::int as n from public.ordering_goods_receipts where purchase_order_id = $1", [po.id]))[0].n as number;
    const [closure, receipt] = results;
    if (status === "CLOSED") {
      expect(closure!.status).toBe("fulfilled");
      expect(received).toBe(2); // 종결된 발주는 모두 입고된 상태다
    } else {
      expect(closure!.status).toBe("rejected"); // 입고가 아직 끝나지 않아 종결이 차단됐다
      expect(receipt!.status).toBe("fulfilled");
      expect(received).toBe(2);
    }
    expect(received).toBeLessThanOrEqual(2);
  });
});

describe("발주 취소의 실제 동시성과 DB 방어 (두 독립 세션)", () => {
  it("발주 3권에 두 세션이 동시에 2권씩 취소를 요청하면 하나만 성공하고, 같은 요청에 동시에 2권씩 수락해도 요청량을 넘지 못한다", async () => {
    const { po, poLineId } = await sentPo(1, 3, createPgProcurementApi({ pool: db.pool() }));
    const requests = await Promise.allSettled([requestCancel(createPgProcurementApi({ pool: db.pool() }), po.id, poLineId, 2), requestCancel(createPgProcurementApi({ pool: db.pool() }), po.id, poLineId, 2)]);
    expect(outcomes(requests)).toEqual(["BUSINESS_INVARIANT", "OK"]);

    const request = (requests.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value;
    const responses = await Promise.allSettled([respondCancel(createPgProcurementApi({ pool: db.pool() }), po.id, request.id, 2, 0), respondCancel(createPgProcurementApi({ pool: db.pool() }), po.id, request.id, 2, 0)]);
    expect(outcomes(responses)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect((await rows("select coalesce(sum(accepted_quantity), 0)::int as n from public.ordering_po_cancellation_responses where request_id = $1", [request.id]))[0].n).toBe(2);
  });

  it("직접 SQL로도 전달 전 발주에 취소 요청·응답을 넣거나 요청량을 넘겨 응답하거나 요청을 발주 수량보다 크게 낼 수 없다", async () => {
    const api = createPgProcurementApi({ pool: db.pool() });
    const draftLine = await confirmedLine(2, 1);
    const draft = await create(api, "sup-a", [(await allocate(api, draftLine, "sup-a", 1)).id]);
    const { po, poLineId } = await sentPo(3, 3, api);
    const c = await db.connect();
    const q = (sql: string) => () => c.query(sql);
    const reqIns = (poId: string, lineId: string, n: number) => `insert into public.ordering_po_cancellation_requests (tenant_id, purchase_order_id, po_line_id, quantity, reason) values ('${T_A}', '${poId}', '${lineId}', ${n}, '사유') returning id`;
    try {
      expect(await sqlState(q(reqIns(draft.id, draft.lines[0]!.poLineId, 1)))).toBe("P0001"); // 전달 전 발주
      expect(await sqlState(q(reqIns(po.id, poLineId, 4)))).toBe("P0001"); // 발주 3권 초과
      const requestId = (await c.query(reqIns(po.id, poLineId, 2))).rows[0].id as string;
      const resIns = (a: number, r: number) => `insert into public.ordering_po_cancellation_responses (tenant_id, purchase_order_id, po_line_id, request_id, accepted_quantity, rejected_quantity, evidence, replied_at) values ('${T_A}', '${po.id}', '${poLineId}', '${requestId}', ${a}, ${r}, '근거', now())`;
      expect(await sqlState(q(resIns(2, 1)))).toBe("P0001"); // 요청 2권 초과
      await c.query(resIns(1, 0));
      expect(await sqlState(q(resIns(1, 1)))).toBe("P0001"); // 이미 1권 응답, 남은 1권뿐
      await c.query(resIns(0, 1));
    } finally {
      await c.end();
    }
  });
});

describe("조달 배정의 실제 동시성과 DB 방어 (두 독립 세션)", () => {
  it("주문 품목 3권에 두 세션이 동시에 2권씩 배정하면 하나만 성공한다", async () => {
    const line = await confirmedLine(12, 3);
    const results = await Promise.allSettled([allocate(createPgProcurementApi({ pool: db.pool() }), line, "sup-a", 2), allocate(createPgProcurementApi({ pool: db.pool() }), line, "sup-b", 2)]);
    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect((await rows("select coalesce(sum(quantity), 0)::int as n from public.ordering_sourcing_allocations where order_line_id = $1 and status = 'ACTIVE'", [line.lineId]))[0].n).toBe(2);
  });

  it("같은 배정을 발주에 연결하는 것과 해제하는 것이 동시에 들어오면 하나만 성공한다", async () => {
    const line = await confirmedLine(13, 2);
    const allocation = await allocate(createPgProcurementApi({ pool: db.pool() }), line, "sup-a", 2);

    const results = await Promise.allSettled([create(createPgProcurementApi({ pool: db.pool() }), "sup-a", [allocation.id]), release(createPgProcurementApi({ pool: db.pool() }), allocation.id)]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    const linkedCount = (await rows("select count(*)::int as n from public.ordering_po_links where allocation_id = $1", [allocation.id]))[0].n as number;
    const status = (await rows("select status from public.ordering_sourcing_allocations where id = $1", [allocation.id]))[0].status as string;
    expect(status === "RELEASED" ? linkedCount : 1 - linkedCount).toBe(0); // 해제된 배정은 연결되지 않았고, 연결된 배정은 해제되지 않았다
  });

  it("직접 SQL로도 주문 품목 수량을 넘겨 배정하거나 종결 주문에 배정하거나 해제된 배정을 되살릴 수 없다", async () => {
    const line = await confirmedLine(14, 2);
    const c = await db.connect();
    const q = (sql: string) => () => c.query(sql);
    const ins = (orderId: string, lineId: string, quantity: number) => `insert into public.ordering_sourcing_allocations (tenant_id, order_id, order_line_id, supplier_code, quantity) values ('${T_A}', '${orderId}', '${lineId}', 'sup-a', ${quantity}) returning id`;
    try {
      expect(await sqlState(q(ins(line.orderId, line.lineId, 3)))).toBe("P0001"); // 품목 2권 초과
      const id = (await c.query(ins(line.orderId, line.lineId, 2))).rows[0].id as string;
      expect(await sqlState(q(ins(line.orderId, line.lineId, 1)))).toBe("P0001"); // 이미 2권 배정
      expect(await sqlState(q(`update public.ordering_sourcing_allocations set quantity = 1 where id = '${id}'`))).toBe("P0001"); // 수량 변경 금지
      await c.query(`update public.ordering_sourcing_allocations set status = 'RELEASED' where id = '${id}'`);
      expect(await sqlState(q(`update public.ordering_sourcing_allocations set status = 'ACTIVE' where id = '${id}'`))).toBe("P0001"); // 되살리기 금지
      const closed = await confirmedLine(15, 1);
      await c.query(`update public.ordering_orders set closed_at = now(), version = version + 1 where id = '${closed.orderId}'`);
      expect(await sqlState(q(ins(closed.orderId, closed.lineId, 1)))).toBe("P0001"); // 종결 주문
    } finally {
      await c.end();
    }
  });
});

void createPgReceivingApi;
void sqlState;
