import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values
       ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false), ($5, $6, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, EX_STAFF_A, T_B, OWNER_B],
  );
  for (let n = 1; n <= 30; n++) {
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
const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const num = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0].n as number;
const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();

/** 확정 주문(품목 1개, 단가 15,000원)을 만든다. 결제는 `paid`가 true일 때 전액 확인한다 */
async function confirmedOrder(book: number, quantity: number, paid = false) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  if (paid) {
    const pay = createPgPaymentApi({ pool: db.pool() });
    const p = await pay.recordPayment(staff, { tenantId: T_A, orderId: order.id, method: "BANK_TRANSFER", amountKrw: String(quantity * 15000), externalReference: `R-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
    await pay.confirmPayment(staff, { tenantId: T_A, paymentId: p.id, evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
  }
  return { orderId: order.id, lineId: order.lines[0]!.lineId };
}

/** 발주(SENT) 하나와 품목 하나를 시드하고, 주어진 주문 품목들을 그 발주 품목에 연결한다(발주 생성 영속화는 별도 증분) */
async function purchaseOrder(book: number, links: { orderId: string; lineId: string; quantity: number }[], poQuantity = links.reduce((s, l) => s + l.quantity, 0)) {
  const c = await db.connect();
  try {
    const po = (await c.query(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T_A])).rows[0].id as string;
    const line = (await c.query(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, $4) returning id`, [T_A, po, BOOK(book), poQuantity])).rows[0].id as string;
    for (const l of links) {
      await c.query(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, $5)`, [T_A, line, l.orderId, l.lineId, l.quantity]);
    }
    return { poId: po, poLineId: line };
  } finally {
    await c.end();
  }
}
const receive = (api: ReturnType<typeof createPgReceivingApi>, po: { poId: string; poLineId: string }, normalQuantity: number, extra: Record<string, unknown> = {}, actor = staff) =>
  api.receiveGoods(actor, {
    tenantId: T_A,
    purchaseOrderId: po.poId,
    poLineId: po.poLineId,
    normalQuantity,
    damagedQuantity: 0,
    misdeliveredQuantity: 0,
    receivedAt: "2026-03-04T06:35:00.000Z",
    idempotencyKey: key(),
    ...extra,
  });
const allocate = (api: ReturnType<typeof createPgReceivingApi>, receiptId: string, o: { orderId: string; lineId: string }, quantity: number, actor = staff) =>
  api.allocateReceipt(actor, { tenantId: T_A, receiptId, orderId: o.orderId, orderLineId: o.lineId, quantity, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });

/** 주문 하나(book, 수량 q)가 발주에 연결되고 입고 q권이 등록된 세계 */
async function receivedScene(book: number, q: number, paid = false) {
  const api = createPgReceivingApi({ pool: db.pool() });
  const order = await confirmedOrder(book, q, paid);
  const po = await purchaseOrder(book, [{ orderId: order.orderId, lineId: order.lineId, quantity: q }]);
  const receipt = await receive(api, po, q);
  return { api, order, po, receipt };
}

describe("createPgReceivingApi.receiveGoods: 검수 입고", () => {
  it("검수 입고가 저장되고(검수자는 인증된 사용자), 같은 멱등 키는 같은 입고를 돌려준다(재시작 뒤에도)", async () => {
    const order = await confirmedOrder(1, 3);
    const po = await purchaseOrder(1, [{ orderId: order.orderId, lineId: order.lineId, quantity: 3 }]);
    const body = { tenantId: T_A, purchaseOrderId: po.poId, poLineId: po.poLineId, normalQuantity: 2, damagedQuantity: 1, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() };

    const receipt = await createPgReceivingApi({ pool: db.pool() }).receiveGoods(staff, { ...body, inspectedBy: "다른사람" } as never);
    const retry = await createPgReceivingApi({ pool: db.pool() }).receiveGoods(staff, body);

    expect(receipt).toMatchObject({ purchaseOrderId: po.poId, poLineId: po.poLineId, normalQuantity: 2, damagedQuantity: 1, excessQuantity: 0, inspectedBy: STAFF_A });
    expect(retry).toEqual(receipt);
    expect(await num("select count(*)::int as n from public.ordering_goods_receipts where purchase_order_id = $1", [po.poId])).toBe(1);
  });

  it("발주 잔량을 넘는 정상 수량은 초과로 분리되고, 발주 상태가 SENT·ACKNOWLEDGED가 아니거나 없는 발주·품목·타 서점은 거부된다", async () => {
    const api = createPgReceivingApi({ pool: db.pool() });
    const order = await confirmedOrder(2, 3);
    const po = await purchaseOrder(2, [{ orderId: order.orderId, lineId: order.lineId, quantity: 3 }]);

    const first = await receive(api, po, 5); // 잔량 3
    expect(first).toMatchObject({ normalQuantity: 3, excessQuantity: 2 });
    expect((await receive(api, po, 1)).excessQuantity).toBe(1); // 이미 다 받았다

    // 없는 대상은 상태와 무관하게 NOT_FOUND다
    expect(await codeOf(() => receive(api, { poId: "0a000000-0000-4000-8000-00000000ffff", poLineId: po.poLineId }, 1))).toBe("NOT_FOUND");
    expect(await codeOf(() => receive(api, { poId: po.poId, poLineId: "0a000000-0000-4000-8000-00000000ffff" }, 1))).toBe("NOT_FOUND");
    expect(await codeOf(() => api.receiveGoods({ userId: OWNER_B }, { tenantId: T_B, purchaseOrderId: po.poId, poLineId: po.poLineId, normalQuantity: 1, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() }))).toBe("NOT_FOUND");
    const c = await db.connect();
    await c.query(`update public.ordering_purchase_orders set status = 'CANCELLED' where id = $1`, [po.poId]);
    await c.end();
    expect(await codeOf(() => receive(api, po, 1))).toBe("BUSINESS_INVARIANT");
  });

  it("공급처가 확정한 품절·수락된 취소는 유효 발주량에서 빠져 입고 한도가 줄어든다", async () => {
    const api = createPgReceivingApi({ pool: db.pool() });
    const order = await confirmedOrder(3, 5);
    const po = await purchaseOrder(3, [{ orderId: order.orderId, lineId: order.lineId, quantity: 5 }]);
    const c = await db.connect();
    await c.query(
      `insert into public.ordering_po_replies (tenant_id, purchase_order_id, po_line_id, kind, quantity, source, evidence, replied_at) values ($1, $2, $3, 'OUT_OF_STOCK', 2, 'UNANSWERED', '공급처 회신', now())`,
      [T_A, po.poId, po.poLineId],
    );
    await c.end();

    expect(await receive(api, po, 5)).toMatchObject({ normalQuantity: 3, excessQuantity: 2 }); // 유효 발주량 5 - 품절 2
  });

  it("비멤버·비활성은 FORBIDDEN, 인증 없음은 UNAUTHENTICATED이다", async () => {
    const api = createPgReceivingApi({ pool: db.pool() });
    const order = await confirmedOrder(4, 1);
    const po = await purchaseOrder(4, [{ orderId: order.orderId, lineId: order.lineId, quantity: 1 }]);

    expect(await codeOf(() => receive(api, po, 1, {}, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => receive(api, po, 1, {}, { userId: EX_STAFF_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => receive(api, po, 1, {}, { userId: "" }))).toBe("UNAUTHENTICATED");
  });
});

describe("입고·배분의 본문 참조 ID는 uuid 형식이어야 한다", () => {
  const MISSING_ID = "0a000000-0000-4000-8000-0000000000fc";

  it("입고(poLineId)와 배분(orderId·orderLineId)의 본문 ID가 uuid 형식이 아니면 조회(404·422)보다 먼저 VALIDATION_ERROR이고 아무것도 저장되지 않으며, uuid 형식이면 없는 대상은 기존 오류를 그대로 낸다", async () => {
    const { api, order, po, receipt } = await receivedScene(14, 2);
    const receipts = () => num("select count(*)::int as n from public.ordering_goods_receipts");
    const allocations = () => num("select count(*)::int as n from public.ordering_receipt_allocations");
    const [receiptsBefore, allocationsBefore] = [await receipts(), await allocations()];

    for (const bad of ["not-a-uuid", "", 123, null]) {
      expect(await codeOf(() => receive(api, po, 1, { poLineId: bad })), `입고 ${JSON.stringify(bad)}`).toBe("VALIDATION_ERROR");
      expect(await codeOf(() => api.allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: bad as never, orderLineId: order.lineId, quantity: 1, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() })), `배분 orderId ${JSON.stringify(bad)}`).toBe("VALIDATION_ERROR");
      expect(await codeOf(() => api.allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: order.orderId, orderLineId: bad as never, quantity: 1, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() })), `배분 orderLineId ${JSON.stringify(bad)}`).toBe("VALIDATION_ERROR");
    }
    // 형식은 맞지만 없는 대상은 기존 오류를 그대로 낸다
    expect(await codeOf(() => receive(api, po, 1, { poLineId: MISSING_ID }))).toBe("NOT_FOUND");
    expect(await codeOf(() => api.allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: MISSING_ID, orderLineId: order.lineId, quantity: 1, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT");
    expect(await receipts()).toBe(receiptsBefore);
    expect(await allocations()).toBe(allocationsBefore);
  });
});

describe("createPgReceivingApi.allocateReceipt / releaseAllocation: 고객별 배분", () => {
  it("배분하면 저장되고, 입고 정상량·발주 연결 수량을 넘는 배분과 연결되지 않은 주문은 거부된다", async () => {
    const api = createPgReceivingApi({ pool: db.pool() });
    const [a, b, outsider] = [await confirmedOrder(5, 2), await confirmedOrder(5, 2), await confirmedOrder(5, 1)];
    const po = await purchaseOrder(5, [
      { orderId: a.orderId, lineId: a.lineId, quantity: 2 },
      { orderId: b.orderId, lineId: b.lineId, quantity: 2 },
    ]);
    const receipt = await receive(api, po, 3); // 정상 3권

    const first = await allocate(api, receipt.id, a, 2);
    expect(first).toMatchObject({ receiptId: receipt.id, orderId: a.orderId, quantity: 2, allocatedBy: STAFF_A });
    expect(await codeOf(() => allocate(api, receipt.id, a, 1))).toBe("BUSINESS_INVARIANT"); // 연결 수량 2 초과
    expect(await codeOf(() => allocate(api, receipt.id, b, 2))).toBe("BUSINESS_INVARIANT"); // 남은 정상량 1 초과
    expect((await allocate(api, receipt.id, b, 1)).quantity).toBe(1);
    expect(await codeOf(() => allocate(api, receipt.id, outsider, 1))).toBe("BUSINESS_INVARIANT"); // 발주에 연결되지 않은 주문
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_receipt_allocations where receipt_id = $1", [receipt.id])).toBe(3);
  });

  it("해제한 수량은 다시 배분할 수 있고, 남은 배분량을 넘는 해제는 거부된다", async () => {
    const { api, order, receipt } = await receivedScene(6, 2);
    const allocation = await allocate(api, receipt.id, order, 2);

    const release = await api.releaseAllocation(staff, { tenantId: T_A, allocationId: allocation.id, quantity: 1, reason: "고객이 1권 변경", releasedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: key() });
    expect(release).toMatchObject({ allocationId: allocation.id, quantity: 1, releasedBy: STAFF_A });
    expect(await codeOf(() => api.releaseAllocation(staff, { tenantId: T_A, allocationId: allocation.id, quantity: 2, reason: "초과", releasedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT");
    expect((await allocate(api, receipt.id, order, 1)).quantity).toBe(1); // 풀린 1권을 다시 배분
  });
});

describe("입고·배분의 실제 동시성 (두 독립 세션)", () => {
  it("마지막 1권(입고 정상 1권)을 두 고객 주문에 동시에 배분하면 하나만 성공한다", async () => {
    const api = createPgReceivingApi({ pool: db.pool() });
    const [a, b] = [await confirmedOrder(7, 1), await confirmedOrder(7, 1)];
    const po = await purchaseOrder(7, [
      { orderId: a.orderId, lineId: a.lineId, quantity: 1 },
      { orderId: b.orderId, lineId: b.lineId, quantity: 1 },
    ]);
    const receipt = await receive(api, po, 1);

    const results = await Promise.allSettled([
      allocate(createPgReceivingApi({ pool: db.pool() }), receipt.id, a, 1),
      allocate(createPgReceivingApi({ pool: db.pool() }), receipt.id, b, 1, owner),
    ]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_receipt_allocations where receipt_id = $1", [receipt.id])).toBe(1);
  });

  it("입고 3권에 주문 8건이 동시에 1권씩 배분하면 정확히 3건만 성공한다", async () => {
    const api = createPgReceivingApi({ pool: db.pool() });
    const targets = [];
    for (let i = 0; i < 8; i++) targets.push(await confirmedOrder(8, 1));
    const po = await purchaseOrder(8, targets.map((t) => ({ orderId: t.orderId, lineId: t.lineId, quantity: 1 })));
    const receipt = await receive(api, po, 3);

    const results = await Promise.allSettled(targets.map((t) => allocate(createPgReceivingApi({ pool: db.pool() }), receipt.id, t, 1)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_receipt_allocations where receipt_id = $1", [receipt.id])).toBe(3);
  });

  it("같은 주문 품목에 연결 수량(2권)보다 많이 서로 다른 입고에서 동시에 배분해도 합계는 연결 수량을 넘지 않는다", async () => {
    const order = await confirmedOrder(9, 2);
    const po = await purchaseOrder(9, [{ orderId: order.orderId, lineId: order.lineId, quantity: 2 }], 6);
    const api = createPgReceivingApi({ pool: db.pool() });
    const [r1, r2] = [await receive(api, po, 2), await receive(api, po, 2)];

    const results = await Promise.allSettled([
      allocate(createPgReceivingApi({ pool: db.pool() }), r1.id, order, 2),
      allocate(createPgReceivingApi({ pool: db.pool() }), r2.id, order, 2),
    ]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
  });

  it("발주 잔량 3권에 두 세션이 동시에 정상 2권씩 입고하면 정상 합계는 3권이고 나머지는 초과로 분리된다", async () => {
    const order = await confirmedOrder(10, 3);
    const po = await purchaseOrder(10, [{ orderId: order.orderId, lineId: order.lineId, quantity: 3 }]);

    const [x, y] = await Promise.all([
      receive(createPgReceivingApi({ pool: db.pool() }), po, 2),
      receive(createPgReceivingApi({ pool: db.pool() }), po, 2),
    ]);

    expect(x.normalQuantity + y.normalQuantity).toBe(3);
    expect(x.excessQuantity + y.excessQuantity).toBe(1);
    expect(await num("select coalesce(sum(normal_quantity), 0)::int as n from public.ordering_goods_receipts where po_line_id = $1", [po.poLineId])).toBe(3);
  });

  it("같은 멱등 키로 동시에 배분해도 배분은 1건이고 두 호출이 같은 결과를 받는다", async () => {
    const { order, receipt } = await receivedScene(11, 2);
    const body = { tenantId: T_A, receiptId: receipt.id, orderId: order.orderId, orderLineId: order.lineId, quantity: 1, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() };

    const [x, y] = await Promise.all([createPgReceivingApi({ pool: db.pool() }).allocateReceipt(staff, body), createPgReceivingApi({ pool: db.pool() }).allocateReceipt(staff, body)]);

    expect(x.id).toBe(y.id);
    expect(await num("select count(*)::int as n from public.ordering_receipt_allocations where receipt_id = $1", [receipt.id])).toBe(1);
  });
});

describe("입고 배분 출처의 인도 (postFulfillment, RECEIPT_ALLOCATION)", () => {
  const fulfill = (api: ReturnType<typeof createPgFulfillmentApi>, order: { orderId: string; lineId: string }, allocationId: string, quantity: number, actor = staff) =>
    api.postFulfillment(actor, {
      tenantId: T_A,
      orderId: order.orderId,
      orderLineId: order.lineId,
      sources: [{ kind: "RECEIPT_ALLOCATION", sourceId: allocationId, quantity }],
      receivedAt: "2026-03-04T06:50:00.000Z",
      idempotencyKey: key(),
    });

  it("배분된 입고 물량을 인도하면 수령 기록과 배분 인도가 저장되고, 배분 잔량·결제 확인액을 넘는 인도와 다른 주문의 배분은 거부된다", async () => {
    const { api, order, receipt } = await receivedScene(12, 2, true);
    const other = await receivedScene(13, 1, true);
    const allocation = await allocate(api, receipt.id, order, 2);
    const otherAllocation = await allocate(other.api, other.receipt.id, other.order, 1);
    const ful = createPgFulfillmentApi({ pool: db.pool() });

    expect(await codeOf(() => fulfill(ful, order, allocation.id, 3))).toBe("BUSINESS_INVARIANT"); // 배분 2권 초과
    expect(await codeOf(() => fulfill(ful, order, otherAllocation.id, 1))).toBe("BUSINESS_INVARIANT"); // 다른 주문의 배분
    const fulfillment = await fulfill(ful, order, allocation.id, 2);

    expect(fulfillment).toMatchObject({ quantity: 2, amountKrw: "30000", receivedBy: STAFF_A });
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_allocation_deliveries where allocation_id = $1", [allocation.id])).toBe(2);
    expect(await codeOf(() => api.releaseAllocation(staff, { tenantId: T_A, allocationId: allocation.id, quantity: 1, reason: "이미 인도", releasedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT");
    // 결제가 없는 주문은 인도할 수 없다
    const unpaid = await receivedScene(14, 1, false);
    const unpaidAllocation = await allocate(unpaid.api, unpaid.receipt.id, unpaid.order, 1);
    expect(await codeOf(() => fulfill(ful, unpaid.order, unpaidAllocation.id, 1))).toBe("BUSINESS_INVARIANT");
  });

  it("마지막 1권을 두 세션이 동시에 인도하면 하나만 성공하고, 인도와 해제가 같은 1권을 두고 동시에 들어와도 하나만 성공한다", async () => {
    const a = await receivedScene(15, 1, true);
    const alloc = await allocate(a.api, a.receipt.id, a.order, 1);
    const race = await Promise.allSettled([
      fulfill(createPgFulfillmentApi({ pool: db.pool() }), a.order, alloc.id, 1),
      fulfill(createPgFulfillmentApi({ pool: db.pool() }), a.order, alloc.id, 1, owner),
    ]);
    expect(outcomes(race)).toEqual(["BUSINESS_INVARIANT", "OK"]);

    const b = await receivedScene(16, 1, true);
    const allocB = await allocate(b.api, b.receipt.id, b.order, 1);
    const mixed = await Promise.allSettled([
      fulfill(createPgFulfillmentApi({ pool: db.pool() }), b.order, allocB.id, 1),
      createPgReceivingApi({ pool: db.pool() }).releaseAllocation(staff, { tenantId: T_A, allocationId: allocB.id, quantity: 1, reason: "고객 변경", releasedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() }),
    ]);
    expect(outcomes(mixed)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    const delivered = await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_allocation_deliveries where allocation_id = $1", [allocB.id]);
    const released = await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_allocation_releases where allocation_id = $1", [allocB.id]);
    expect(delivered + released).toBe(1); // 같은 1권을 인도와 해제가 동시에 차지하지 못한다
  });

  it("예약 출처와 배분 출처를 함께 쓰는 인도도 한 트랜잭션으로 저장되고 교착 없이 끝난다", async () => {
    const { api, order, receipt } = await receivedScene(17, 1, true);
    const allocation = await allocate(api, receipt.id, order, 1);
    const ful = createPgFulfillmentApi({ pool: db.pool() });

    const results = await Promise.allSettled([
      fulfill(ful, order, allocation.id, 1),
      fulfill(createPgFulfillmentApi({ pool: db.pool() }), (await receivedScene(18, 1, true)).order, "0a000000-0000-4000-8000-00000000ffff", 1),
    ]);

    expect(outcomes(results)).toEqual(["NOT_FOUND", "OK"]);
  });
});

describe("입고·배분 DB 불변식 (어댑터를 거치지 않는 쓰기도 지킨다)", () => {
  it("직접 SQL로도 배분은 입고 정상량·연결 수량을 넘을 수 없고, 두 세션이 마지막 1권을 동시에 넣으면 하나만 들어간다", async () => {
    const [a, b] = [await confirmedOrder(19, 1), await confirmedOrder(19, 1)];
    const po = await purchaseOrder(19, [
      { orderId: a.orderId, lineId: a.lineId, quantity: 1 },
      { orderId: b.orderId, lineId: b.lineId, quantity: 1 },
    ]);
    const receipt = await receive(createPgReceivingApi({ pool: db.pool() }), po, 1);
    const insert = (o: { orderId: string; lineId: string }, qty: number) =>
      `insert into public.ordering_receipt_allocations (tenant_id, receipt_id, order_id, order_line_id, quantity, allocated_by, allocated_at) values ('${T_A}', '${receipt.id}', '${o.orderId}', '${o.lineId}', ${qty}, 'raw', now())`;
    const x = await db.connect();
    const y = await db.connect();
    try {
      expect(await sqlState(() => x.query(insert(a, 2)))).toBe("P0001"); // 입고 1권 초과
      await x.query("begin");
      await y.query("begin");
      await x.query(insert(a, 1));
      const second = sqlState(() => y.query(insert(b, 1)));
      await x.query("commit");
      expect(await second).toBe("P0001");
      await y.query("rollback");
    } finally {
      await x.end();
      await y.end();
    }
  });

  it("직접 SQL의 해제·인도는 배분 잔량을 넘을 수 없고, 입고 정상량 합계는 유효 발주량을 넘을 수 없으며, 입고·배분 기록은 추가 전용이다", async () => {
    const { order, po, receipt, api } = await receivedScene(20, 2, true);
    const allocation = await allocate(api, receipt.id, order, 2);
    const c = await db.connect();
    try {
      const delivery = (qty: number) =>
        `insert into public.ordering_allocation_deliveries (tenant_id, allocation_id, receipt_id, order_id, order_line_id, quantity, delivered_by, delivered_at) values ('${T_A}', '${allocation.id}', '${receipt.id}', '${order.orderId}', '${order.lineId}', ${qty}, 'raw', now())`;
      const release = (qty: number) =>
        `insert into public.ordering_allocation_releases (tenant_id, allocation_id, quantity, reason, released_by, released_at) values ('${T_A}', '${allocation.id}', ${qty}, '사유', 'raw', now())`;
      expect(await sqlState(() => c.query(delivery(3)))).toBe("P0001");
      expect(await sqlState(() => c.query(delivery(-1)))).toBe("P0001");
      expect(await sqlState(() => c.query(delivery(1)))).toBeUndefined();
      expect(await sqlState(() => c.query(release(2)))).toBe("P0001"); // 남은 1권 초과
      expect(await sqlState(() => c.query(release(1)))).toBeUndefined();
      expect(
        await sqlState(() =>
          c.query(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, inspected_by, received_at) values ('${T_A}', '${po.poId}', '${po.poLineId}', 1, 'raw', now())`),
        ),
      ).toBe("P0001"); // 이미 2권을 받아 유효 발주량 2권을 채웠다
      for (const sql of [
        "update public.ordering_goods_receipts set normal_quantity = 9",
        "delete from public.ordering_receipt_allocations",
        "update public.ordering_allocation_releases set quantity = 9",
        "delete from public.ordering_allocation_deliveries",
      ]) {
        expect(await sqlState(() => c.query(sql)), sql).toBe("P0001");
      }
    } finally {
      await c.end();
    }
  });
});
