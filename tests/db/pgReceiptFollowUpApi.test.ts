import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgProcurementApi } from "../../src/db/pgProcurementApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER_A]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T_A, OWNER_A, STAFF_A]);
  await c.query(`insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel, version) values ($1, 'sup-a', true, '공급처 A', 'EMAIL', 1)`, [T_A]);
  for (let n = 1; n <= 12; n++) {
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
const key = () => `r-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const detailOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? `${error.code}:${error.detail ?? ""}` : `NON_APP_ERROR:${(error as Error).message}`;
  }
  return "OK";
};
const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();

const procurement = () => createPgProcurementApi({ pool: db.pool() });
const receiving = () => createPgReceivingApi({ pool: db.pool() });

/** 확정 주문 → 조달 배정 → 발주 → 전달(SENT)까지 마친 발주 */
async function sentPo(book: number, quantity: number) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  const api = procurement();
  const allocation = await api.allocateSourcing(staff, { tenantId: T_A, orderId: order.id, lineId, supplierCode: "sup-a", quantity, idempotencyKey: key() });
  const po = await api.createPurchaseOrder(staff, { tenantId: T_A, supplierCode: "sup-a", allocationIds: [allocation.id], idempotencyKey: key() });
  await api.markPurchaseOrderReady(staff, { tenantId: T_A, purchaseOrderId: po.id, expectedVersion: 1, idempotencyKey: key() });
  await api.recordPurchaseOrderDelivery(staff, { tenantId: T_A, purchaseOrderId: po.id, expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z", idempotencyKey: key() });
  return { orderId: order.id, lineId, po, poLineId: po.lines[0]!.poLineId };
}
const receive = (po: { po: { id: string }; poLineId: string }, normal: number, extra: { damaged?: number; misdelivered?: number } = {}) =>
  receiving().receiveGoods(staff, { tenantId: T_A, purchaseOrderId: po.po.id, poLineId: po.poLineId, normalQuantity: normal, damagedQuantity: extra.damaged ?? 0, misdeliveredQuantity: extra.misdelivered ?? 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() });
const closePo = (poId: string, expectedVersion = 3) => procurement().executePurchaseOrderClosure({ tenantId: T_A, purchaseOrderId: poId, expectedVersion, executedAt: "2026-03-04T08:00:00.000Z", idempotencyKey: key() });

type Kind = "DAMAGED" | "MISDELIVERED";
type Outcome = "RETURNED_TO_SUPPLIER" | "SUPPLIER_CREDIT" | "DISCARDED";
const resolveDefect = (receiptId: string, kind: Kind, quantity: number, outcome: Outcome = "RETURNED_TO_SUPPLIER", actor = staff) =>
  receiving().resolveReceiptDefect(actor, { tenantId: T_A, receiptId, kind, quantity, outcome, evidence: "공급처 반품 확인서", resolvedAt: "2026-03-04T07:00:00.000Z", idempotencyKey: key() });
const decideExcess = (receiptId: string, decision: "APPROVED" | "REJECTED", quantity: number, actor = owner) =>
  receiving().decideExcessReceipt(actor, { tenantId: T_A, receiptId, decision, quantity, reason: "점주 결정", decidedAt: "2026-03-04T07:10:00.000Z", idempotencyKey: key() });
const correct = (receiptId: string, quantity: number, actor = owner) =>
  receiving().correctReceipt(actor, { tenantId: T_A, receiptId, quantity, reason: "검수 수량 정정", correctedAt: "2026-03-04T07:20:00.000Z", idempotencyKey: key() });
const allocateTo = (receiptId: string, line: { orderId: string; lineId: string }, quantity: number) =>
  receiving().allocateReceipt(staff, { tenantId: T_A, receiptId, orderId: line.orderId, orderLineId: line.lineId, quantity, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });

describe("파손·오배송 해소 (Postgres 영속화)", () => {
  it("검수에서 기록된 수량만큼 해소하고(폐기는 Owner만), 모두 해소되어야 발주가 종결된다", async () => {
    const po = await sentPo(1, 2);
    const receipt = await receive(po, 2, { damaged: 2, misdelivered: 1 });

    expect(await detailOf(() => closePo(po.po.id))).toContain("DEFECT_UNRESOLVED");
    expect(await resolveDefect(receipt.id, "DAMAGED", 1)).toMatchObject({ kind: "DAMAGED", quantity: 1, outcome: "RETURNED_TO_SUPPLIER", resolvedBy: STAFF_A, purchaseOrderId: po.po.id });
    expect(await codeOf(() => resolveDefect(receipt.id, "DAMAGED", 2))).toBe("BUSINESS_INVARIANT"); // 기록된 2권 중 1권 처리, 2권 더는 초과
    expect(await codeOf(() => resolveDefect(receipt.id, "DAMAGED", 1, "DISCARDED"))).toBe("FORBIDDEN"); // 폐기는 Owner만
    expect(await codeOf(() => resolveDefect(receipt.id, "DAMAGED", 1, "RETURNED_TO_SUPPLIER", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => resolveDefect("0a000000-0000-4000-8000-00000000ffff", "DAMAGED", 1))).toBe("NOT_FOUND");
    expect((await resolveDefect(receipt.id, "DAMAGED", 1, "DISCARDED", owner)).outcome).toBe("DISCARDED");
    expect(await detailOf(() => closePo(po.po.id))).toContain("DEFECT_UNRESOLVED"); // 오배송이 남았다
    await resolveDefect(receipt.id, "MISDELIVERED", 1, "SUPPLIER_CREDIT");
    expect((await closePo(po.po.id)).status).toBe("CLOSED");
    expect((await rows("select count(*)::int as n from public.ordering_receipt_defect_resolutions where receipt_id = $1", [receipt.id]))[0].n).toBe(3);
  });
});

describe("초과입고 결정 (Postgres 영속화)", () => {
  it("초과 수량은 Owner만 승인·거절하고 초과 결정은 불가하며, 모두 결정되어야 발주가 종결된다", async () => {
    const po = await sentPo(2, 2);
    const receipt = await receive(po, 4); // 정상 2 + 초과 2

    expect(receipt).toMatchObject({ normalQuantity: 2, excessQuantity: 2 });
    expect(await detailOf(() => closePo(po.po.id))).toContain("EXCESS_UNDECIDED");
    expect(await codeOf(() => decideExcess(receipt.id, "APPROVED", 1, staff))).toBe("FORBIDDEN");
    expect(await decideExcess(receipt.id, "APPROVED", 1)).toMatchObject({ decision: "APPROVED", quantity: 1, decidedBy: OWNER_A });
    expect(await codeOf(() => decideExcess(receipt.id, "REJECTED", 2))).toBe("BUSINESS_INVARIANT"); // 초과 2권 중 1권 결정, 2권 더는 초과
    expect(await codeOf(() => decideExcess("0a000000-0000-4000-8000-00000000ffff", "APPROVED", 1))).toBe("NOT_FOUND");
    await decideExcess(receipt.id, "REJECTED", 1);
    expect((await closePo(po.po.id)).status).toBe("CLOSED");
  });
});

describe("입고 정정 (Postgres 영속화)", () => {
  it("Owner만 미배분 수량 안에서 정정하고, 정정한 수량은 발주 잔량으로 돌아가 다시 입고할 수 있다", async () => {
    const po = await sentPo(3, 3);
    const receipt = await receive(po, 3);
    await allocateTo(receipt.id, po, 2);

    expect(await codeOf(() => correct(receipt.id, 1, staff))).toBe("FORBIDDEN"); // 거래 정정은 Owner 승인 업무
    expect(await codeOf(() => correct(receipt.id, 2))).toBe("BUSINESS_INVARIANT"); // 미배분은 1권뿐
    expect(await codeOf(() => correct("0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    expect(await correct(receipt.id, 1)).toMatchObject({ quantity: 1, correctedBy: OWNER_A, receiptId: receipt.id });
    expect(await codeOf(() => correct(receipt.id, 1))).toBe("BUSINESS_INVARIANT"); // 남은 3-1 중 2권은 배분되어 있다
    expect((await rows("select coalesce(sum(quantity), 0)::int as n from public.ordering_receipt_corrections where receipt_id = $1", [receipt.id]))[0].n).toBe(1);

    expect((await receive(po, 1)).normalQuantity).toBe(1); // 정정한 1권은 발주 잔량으로 돌아왔다
    expect(await codeOf(() => allocateTo(receipt.id, po, 1))).toBe("BUSINESS_INVARIANT"); // 정정으로 정상 순량이 줄어 배분 한도를 넘는다
  });
});

/** 같은 도서에 대한 두 고객 주문을 한 발주로 묶어 전달(SENT)까지 마친다 */
async function sentSharedPo(book: number, quantities: [number, number]) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const api = procurement();
  const lines: { orderId: string; lineId: string }[] = [];
  const allocationIds: string[] = [];
  for (const quantity of quantities) {
    const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
    const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
    lines.push({ orderId: order.id, lineId: order.lines[0]!.lineId });
    allocationIds.push((await api.allocateSourcing(staff, { tenantId: T_A, orderId: order.id, lineId: order.lines[0]!.lineId, supplierCode: "sup-a", quantity, idempotencyKey: key() })).id);
  }
  const po = await api.createPurchaseOrder(staff, { tenantId: T_A, supplierCode: "sup-a", allocationIds, idempotencyKey: key() });
  await api.markPurchaseOrderReady(staff, { tenantId: T_A, purchaseOrderId: po.id, expectedVersion: 1, idempotencyKey: key() });
  await api.recordPurchaseOrderDelivery(staff, { tenantId: T_A, purchaseOrderId: po.id, expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z", idempotencyKey: key() });
  return { lines, po, poLineId: po.lines[0]!.poLineId };
}
const cancelAlloc = (allocationId: string, quantity: number, actor = owner) =>
  receiving().cancelAllocation(actor, { tenantId: T_A, allocationId, quantity, reason: "고객 취소", cancelledAt: "2026-03-04T06:50:00.000Z", idempotencyKey: key() });
const releaseAlloc = (allocationId: string, quantity: number) =>
  receiving().releaseAllocation(staff, { tenantId: T_A, allocationId, quantity, reason: "배분 해제", releasedAt: "2026-03-04T06:45:00.000Z", idempotencyKey: key() });
const reallocate = (allocationId: string, to: { orderId: string; lineId: string }, quantity: number, actor = owner) =>
  receiving().reallocateAllocation(actor, { tenantId: T_A, allocationId, toOrderId: to.orderId, toOrderLineId: to.lineId, quantity, reason: "다른 고객에게 배분", actedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() });

describe("배분 취소·재배정 (Postgres 영속화)", () => {
  it("Owner만 미인도 잔량 안에서 배분을 취소해 처분 대기로 보내고, 해제와 합쳐 잔량을 넘을 수 없다", async () => {
    const po = await sentPo(6, 3);
    const receipt = await receive(po, 3);
    const allocation = await allocateTo(receipt.id, po, 3);

    expect(await codeOf(() => cancelAlloc(allocation.id, 1, staff))).toBe("FORBIDDEN"); // 취소 확정은 Owner 업무
    expect(await codeOf(() => cancelAlloc("0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    const cancelled = await cancelAlloc(allocation.id, 2);
    expect(cancelled).toMatchObject({ allocationId: allocation.id, quantity: 2, cancelledBy: OWNER_A, orderId: po.orderId, receiptId: receipt.id, bookId: BOOK(6) });
    expect((await rows("select quantity::int as quantity, book_key, cancelled_by from public.ordering_allocation_cancellations where allocation_id = $1", [allocation.id]))[0]).toEqual({ quantity: 2, book_key: BOOK(6), cancelled_by: OWNER_A });
    expect(await codeOf(() => cancelAlloc(allocation.id, 2))).toBe("BUSINESS_INVARIANT"); // 잔량 1권뿐
    await releaseAlloc(allocation.id, 1);
    expect(await codeOf(() => cancelAlloc(allocation.id, 1))).toBe("BUSINESS_INVARIANT"); // 해제로 잔량이 0
  });

  it("같은 발주 품목에 연결된 다른 고객에게 배분을 옮기고(다른 고객은 Owner만), 해제와 새 배분이 함께 저장되며 한도·연결을 넘을 수 없다", async () => {
    const shared = await sentSharedPo(7, [2, 2]);
    const receipt = await receive(shared, 4);
    const [first, second] = shared.lines as [{ orderId: string; lineId: string }, { orderId: string; lineId: string }];
    const allocation = await allocateTo(receipt.id, first, 2);

    expect(await codeOf(() => reallocate(allocation.id, second, 1, staff))).toBe("FORBIDDEN"); // 다른 고객으로의 재배분은 Owner만
    expect(await codeOf(() => reallocate(allocation.id, second, 3))).toBe("BUSINESS_INVARIANT"); // 배분 잔량 2권 초과
    const stray = await sentPo(8, 1); // 이 발주와 연결되지 않은 주문 품목
    expect(await codeOf(() => reallocate(allocation.id, stray, 1))).toBe("BUSINESS_INVARIANT");
    const moved = await reallocate(allocation.id, second, 1);
    expect(moved.release).toMatchObject({ allocationId: allocation.id, quantity: 1 });
    expect(moved.allocation).toMatchObject({ orderId: second.orderId, orderLineId: second.lineId, quantity: 1, receiptId: receipt.id });
    expect((await rows("select count(*)::int as n from public.ordering_allocation_releases where allocation_id = $1", [allocation.id]))[0].n).toBe(1);
    expect((await rows("select count(*)::int as n from public.ordering_receipt_allocations where order_id = $1", [second.orderId]))[0].n).toBe(1);

    // 한쪽이 실패하면 아무것도 저장되지 않는다: 두 번째 주문 연결 한도(2권)를 넘기는 이동은 해제도 남기지 않는다
    const before = (await rows("select count(*)::int as n from public.ordering_allocation_releases where allocation_id = $1", [allocation.id]))[0].n;
    expect(await codeOf(() => reallocate(allocation.id, second, 2))).toBe("BUSINESS_INVARIANT");
    expect((await rows("select count(*)::int as n from public.ordering_allocation_releases where allocation_id = $1", [allocation.id]))[0].n).toBe(before);
  });
});

describe("입고 후속의 실제 동시성과 DB 방어 (두 독립 세션)", () => {
  it("입고 2권을 정정하는 것과 배분하는 것이 동시에 들어오면 하나만 성공한다", async () => {
    const po = await sentPo(4, 2);
    const receipt = await receive(po, 2);

    const results = await Promise.allSettled([correct(receipt.id, 2), allocateTo(receipt.id, po, 1)]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
  });

  it("직접 SQL로도 배분된 수량을 정정하거나 기록된 수량을 넘겨 해소·결정할 수 없다", async () => {
    const po = await sentPo(5, 2);
    const receipt = await receive(po, 4, { damaged: 1 }); // 정상 2, 초과 2, 파손 1
    await allocateTo(receipt.id, po, 1);
    const c = await db.connect();
    const q = (sql: string) => () => c.query(sql);
    try {
      expect(await sqlState(q(`insert into public.ordering_receipt_corrections (tenant_id, receipt_id, quantity, reason, corrected_by, corrected_at) values ('${T_A}', '${receipt.id}', 2, '사유', 'raw', now())`))).toBe("P0001"); // 미배분 1권뿐
      await c.query(`insert into public.ordering_receipt_corrections (tenant_id, receipt_id, quantity, reason, corrected_by, corrected_at) values ('${T_A}', '${receipt.id}', 1, '사유', 'raw', now())`);
      const resIns = (n: number) => `insert into public.ordering_receipt_defect_resolutions (tenant_id, receipt_id, purchase_order_id, kind, quantity, outcome, evidence, resolved_by, resolved_at) values ('${T_A}', '${receipt.id}', '${po.po.id}', 'DAMAGED', ${n}, 'DISCARDED', '근거', 'raw', now())`;
      expect(await sqlState(q(resIns(2)))).toBe("P0001"); // 파손 1권뿐
      await c.query(resIns(1));
      expect(await sqlState(q(resIns(1)))).toBe("P0001");
      const decIns = (n: number) => `insert into public.ordering_excess_decisions (tenant_id, receipt_id, decision, quantity, reason, decided_by, decided_at) values ('${T_A}', '${receipt.id}', 'APPROVED', ${n}, '사유', 'raw', now())`;
      expect(await sqlState(q(decIns(3)))).toBe("P0001"); // 초과 2권뿐
      await c.query(decIns(2));
      expect(await sqlState(q(`update public.ordering_excess_decisions set quantity = 1 where receipt_id = '${receipt.id}'`))).toBe("P0001"); // 추가 전용
    } finally {
      await c.end();
    }
  });
});

describe("배분 취소의 실제 동시성과 DB 방어 (두 독립 세션)", () => {
  it("배분 잔량 1권을 취소하는 것과 해제하는 것이 동시에 들어오면 하나만 성공한다", async () => {
    const po = await sentPo(9, 1);
    const receipt = await receive(po, 1);
    const allocation = await allocateTo(receipt.id, po, 1);

    const results = await Promise.allSettled([cancelAlloc(allocation.id, 1), releaseAlloc(allocation.id, 1)]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
  });

  it("직접 SQL로도 배분 잔량을 넘겨 취소 처분을 넣을 수 없다", async () => {
    const po = await sentPo(10, 2);
    const receipt = await receive(po, 2);
    const allocation = await allocateTo(receipt.id, po, 2);
    await releaseAlloc(allocation.id, 1);
    const c = await db.connect();
    try {
      const ins = (n: number) => `insert into public.ordering_allocation_cancellations (tenant_id, book_key, receipt_id, allocation_id, order_id, order_line_id, quantity, reason, cancelled_by, cancelled_at) values ('${T_A}', '${BOOK(10)}', '${receipt.id}', '${allocation.id}', '${po.orderId}', '${po.lineId}', ${n}, '사유', 'raw', now())`;
      expect(await sqlState(() => c.query(ins(2)))).toBe("P0001"); // 잔량 1권뿐
      await c.query(ins(1));
      expect(await sqlState(() => c.query(ins(1)))).toBe("P0001");
    } finally {
      await c.end();
    }
  });
});
