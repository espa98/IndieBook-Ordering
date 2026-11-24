import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCancellationApi } from "../../src/db/pgCancellationApi";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
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
const key = () => `k-${++seq}`;
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

/** 확정 주문(품목 1개, 단가 15,000원)과 `paid`면 전액 결제 확인, `reserve`면 재고 예약까지 */
async function scene(book: number, quantity: number, options: { paid?: boolean; reserve?: boolean } = {}) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  let reservationId: string | undefined;
  if (options.reserve) {
    await rows(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', $3, '초기 재고', 'seed', now())`, [T_A, BOOK(book), quantity]);
    reservationId = (await createPgStockApi({ pool: db.pool() }).reserveStock(owner, { tenantId: T_A, orderId: order.id, orderLineId: lineId, quantity, reservedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() })).id;
  }
  let paymentId: string | undefined;
  if (options.paid) {
    const pay = createPgPaymentApi({ pool: db.pool() });
    const p = await pay.recordPayment(staff, { tenantId: T_A, orderId: order.id, method: "BANK_TRANSFER", amountKrw: String(quantity * 15000), externalReference: `CR-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
    await pay.confirmPayment(staff, { tenantId: T_A, paymentId: p.id, evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
    paymentId = p.id;
  }
  return { orderId: order.id, lineId, reservationId, paymentId };
}
const correctPay = (paymentId: string, reducedKrw: string, actor = owner) =>
  createPgPaymentApi({ pool: db.pool() }).correctPayment(actor, { tenantId: T_A, paymentId, reducedKrw, reason: "금액 오기록", evidence: "입금 내역 재확인", correctedAt: "2026-03-04T07:00:00.000Z", idempotencyKey: key() });

describe("결제 정정 (Postgres 영속화)", () => {
  it("Owner만 확인된 결제를 남은 금액 안에서 감액 정정하고, 확인 전 결제·잘못된 금액·초과·없는 결제는 거부된다", async () => {
    const s = await scene(1, 2, { paid: true }); // 30,000원 확인
    const unconfirmed = await createPgPaymentApi({ pool: db.pool() }).recordPayment(staff, { tenantId: T_A, orderId: (await scene(2, 1)).orderId, method: "CARD", amountKrw: "15000", externalReference: `CR-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });

    expect(await codeOf(() => correctPay(s.paymentId!, "5000", staff))).toBe("FORBIDDEN"); // 거래 정정은 Owner 승인 업무
    expect(await codeOf(() => correctPay(s.paymentId!, "5000", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => correctPay(s.paymentId!, "0"))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => correctPay("0a000000-0000-4000-8000-00000000ffff", "5000"))).toBe("NOT_FOUND");
    expect(await codeOf(() => correctPay(unconfirmed.id, "5000"))).toBe("BUSINESS_INVARIANT"); // 확인된 거래에만

    const correction = await correctPay(s.paymentId!, "20000");
    expect(correction).toMatchObject({ orderId: s.orderId, paymentId: s.paymentId, reducedKrw: "20000", correctedBy: OWNER_A });
    expect((await rows("select reduced_krw::text as reduced from public.ordering_payment_corrections where payment_id = $1", [s.paymentId]))[0].reduced).toBe("20000");
    expect(await codeOf(() => correctPay(s.paymentId!, "10001"))).toBe("BUSINESS_INVARIANT"); // 남은 10,000원 초과
    expect((await correctPay(s.paymentId!, "10000")).reducedKrw).toBe("10000");
    expect(await codeOf(() => correctPay(s.paymentId!, "1"))).toBe("BUSINESS_INVARIANT"); // 남은 금액 0
  });

  it("같은 결제를 두 세션이 동시에 정정해도 남은 금액을 넘기지 못하고, 직접 SQL로도 확인 전 결제·남은 금액 초과 정정을 넣을 수 없다", async () => {
    const s = await scene(3, 2, { paid: true });
    const results = await Promise.allSettled([correctPay(s.paymentId!, "20000"), correctPay(s.paymentId!, "20000")]);
    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await num("select coalesce(sum(reduced_krw), 0)::int as n from public.ordering_payment_corrections where payment_id = $1", [s.paymentId])).toBe(20000);

    const other = await scene(4, 1);
    const raw = await createPgPaymentApi({ pool: db.pool() }).recordPayment(staff, { tenantId: T_A, orderId: other.orderId, method: "CARD", amountKrw: "15000", externalReference: `CR-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
    const c = await db.connect();
    try {
      const ins = (paymentId: string, orderId: string, krw: number) => `insert into public.ordering_payment_corrections (tenant_id, order_id, payment_id, reduced_krw, reason, evidence, corrected_by, corrected_at) values ('${T_A}', '${orderId}', '${paymentId}', ${krw}, '사유', '근거', 'raw', now())`;
      expect(await sqlState(() => c.query(ins(raw.id, other.orderId, 100)))).toBe("P0001"); // 확인 전 결제
      expect(await sqlState(() => c.query(ins(s.paymentId!, s.orderId, 10001)))).toBe("P0001"); // 남은 10,000원 초과
      await c.query(ins(s.paymentId!, s.orderId, 10000));
    } finally {
      await c.end();
    }
  });
});

const deliver = (s: { orderId: string; lineId: string; reservationId?: string }, quantity: number) =>
  createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, {
    tenantId: T_A, orderId: s.orderId, orderLineId: s.lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: s.reservationId!, quantity }], receivedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: key(),
  });
type Restoration = { kind: "STOCK_RESERVATION" | "RECEIPT_ALLOCATION"; sourceId: string; quantity: number };
const correctFul = (s: { orderId: string }, fulfillmentId: string, quantity: number, restorations: Restoration[], options: { actor?: { userId: string }; physical?: boolean } = {}) =>
  createPgFulfillmentApi({ pool: db.pool() }).correctFulfillment(options.actor ?? owner, {
    tenantId: T_A, orderId: s.orderId, fulfillmentId, quantity, restorations, reason: "수령 오기록", evidence: "매장 반입 확인", physicalReturnConfirmed: options.physical ?? true, correctedAt: "2026-03-04T07:30:00.000Z", idempotencyKey: key(),
  });
const netDelivered = (lineId: string) => num("select coalesce(sum(quantity), 0)::int as n from public.ordering_fulfillments where order_line_id = $1", [lineId]);

describe("수령 정정 (Postgres 영속화)", () => {
  it("Owner만 실물 반입을 확인한 수령을 출처별로 복원하며 정정하고, 원 수령은 보존되며 복원한 물량은 다시 인도할 수 있다", async () => {
    const s = await scene(5, 2, { paid: true, reserve: true });
    const fulfillment = await deliver(s, 2);
    const restore = (quantity: number): Restoration[] => [{ kind: "STOCK_RESERVATION", sourceId: s.reservationId!, quantity }];

    expect(await codeOf(() => correctFul(s, fulfillment.id, 1, restore(1), { actor: staff }))).toBe("FORBIDDEN");
    expect(await codeOf(() => correctFul(s, fulfillment.id, 1, restore(1), { physical: false }))).toBe("BUSINESS_INVARIANT"); // 실물 반입 미확인
    expect(await codeOf(() => correctFul(s, fulfillment.id, 3, restore(3)))).toBe("BUSINESS_INVARIANT"); // 수령 2권 초과
    expect(await codeOf(() => correctFul(s, fulfillment.id, 1, restore(2)))).toBe("BUSINESS_INVARIANT"); // 복원 합이 정정 수량과 다르다
    expect(await codeOf(() => correctFul(s, "0a000000-0000-4000-8000-00000000ffff", 1, restore(1)))).toBe("NOT_FOUND");

    const correction = await correctFul(s, fulfillment.id, 1, restore(1));
    expect(correction).toMatchObject({ orderId: s.orderId, fulfillmentId: fulfillment.id, quantity: 1, correctedBy: OWNER_A });
    expect(await netDelivered(s.lineId)).toBe(1); // 원 수령 2권은 그대로 두고 음수 행 -1이 더해졌다
    expect((await rows("select quantity, amount_krw::int as amount, corrects_fulfillment_id from public.ordering_fulfillments where id = $1", [correction.reversalFulfillmentId]))[0]).toEqual({ quantity: -1, amount: -15000, corrects_fulfillment_id: fulfillment.id });
    expect(await num("select quantity::int as n from public.ordering_fulfillments where id = $1", [fulfillment.id])).toBe(2); // 원 수령은 보존
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_deliveries where reservation_id = $1", [s.reservationId])).toBe(1);
    expect(await num("select count(*)::int as n from public.ordering_stock_movements where reservation_id = $1 and kind = 'DELIVERY_REVERSAL' and direction = 'IN' and quantity = 1", [s.reservationId])).toBe(1);
    expect(await num("select count(*)::int as n from public.ordering_fulfillment_corrections where fulfillment_id = $1", [fulfillment.id])).toBe(1);

    expect(await codeOf(() => correctFul(s, fulfillment.id, 2, restore(2)))).toBe("BUSINESS_INVARIANT"); // 이미 1권 정정, 남은 1권뿐
    expect((await deliver(s, 1)).quantity).toBe(1); // 복원한 1권은 다시 인도할 수 있다
  });

  it("종결된 주문에도 수령을 정정할 수 있고, 같은 수령을 두 세션이 동시에 정정해도 수령 수량을 넘기지 못한다", async () => {
    const closed = await scene(6, 1, { paid: true, reserve: true });
    const first = await deliver(closed, 1);
    await rows("update public.ordering_orders set closed_at = now(), version = version + 1 where id = $1", [closed.orderId]);
    expect((await correctFul(closed, first.id, 1, [{ kind: "STOCK_RESERVATION", sourceId: closed.reservationId!, quantity: 1 }])).quantity).toBe(1); // 정정은 종결 주문에도 가능하다 (ST-F02)

    const s = await scene(7, 2, { paid: true, reserve: true });
    const fulfillment = await deliver(s, 2);
    const full: Restoration[] = [{ kind: "STOCK_RESERVATION", sourceId: s.reservationId!, quantity: 2 }];
    const results = await Promise.allSettled([correctFul(s, fulfillment.id, 2, full), correctFul(s, fulfillment.id, 2, full)]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await netDelivered(s.lineId)).toBe(0);
  });
});

/** 결제·인도·종결까지 마친 주문 */
async function closedOrder(book: number) {
  const s = await scene(book, 1, { paid: true, reserve: true });
  const fulfillment = await deliver(s, 1);
  const cancellations = createPgCancellationApi({ pool: db.pool() });
  const request = await cancellations.requestOrderClosure(staff, { tenantId: T_A, orderId: s.orderId, expectedVersion: 2, requestedAt: "2026-03-04T06:58:00.000Z", idempotencyKey: key() });
  await cancellations.executeOrderClosure({ tenantId: T_A, closureRequestId: request.id, executedAt: "2026-03-04T06:59:00.000Z", idempotencyKey: key() });
  return { ...s, fulfillmentId: fulfillment.id };
}
const reopen = (orderId: string, trigger: { kind: "PAYMENT_CORRECTION" | "FULFILLMENT_CORRECTION"; id: string }) =>
  createPgCancellationApi({ pool: db.pool() }).executeOrderReopening({ tenantId: T_A, orderId, trigger, executedAt: "2026-03-04T08:00:00.000Z", idempotencyKey: key() });
const orderState = async (orderId: string) => (await rows("select closed_at, version::int as version from public.ordering_orders where id = $1", [orderId]))[0];

describe("주문 재개 (정정으로 종결 조건이 깨졌을 때, 서버 전용)", () => {
  it("종결 뒤 수령 정정으로 종결 조건이 깨지면 서버가 주문을 재개하고 근거를 남기며, 종결되지 않은 주문·없는 정정·다른 주문의 정정은 거부된다", async () => {
    const closed = await closedOrder(8);
    const before = await orderState(closed.orderId);
    expect(before.closed_at).not.toBeNull();
    const correction = await correctFul(closed, closed.fulfillmentId, 1, [{ kind: "STOCK_RESERVATION", sourceId: closed.reservationId!, quantity: 1 }]);

    expect(await codeOf(() => reopen(closed.orderId, { kind: "FULFILLMENT_CORRECTION", id: "0a000000-0000-4000-8000-00000000ffff" }))).toBe("NOT_FOUND");
    const other = await closedOrder(9);
    expect(await codeOf(() => reopen(other.orderId, { kind: "FULFILLMENT_CORRECTION", id: correction.id }))).toBe("NOT_FOUND"); // 다른 주문의 정정은 이 주문의 정정이 아니다
    const reopening = await reopen(closed.orderId, { kind: "FULFILLMENT_CORRECTION", id: correction.id });

    expect(reopening).toMatchObject({ orderId: closed.orderId, executedBy: "SYSTEM", trigger: { kind: "FULFILLMENT_CORRECTION", id: correction.id }, orderVersionBefore: before.version, orderVersionAfter: before.version + 1 });
    expect(reopening.blockers).toContain("UNDELIVERED");
    expect(await orderState(closed.orderId)).toMatchObject({ closed_at: null, version: before.version + 1 });
    expect(await num("select count(*)::int as n from public.ordering_order_reopenings where order_id = $1", [closed.orderId])).toBe(1);
    expect(await codeOf(() => reopen(closed.orderId, { kind: "FULFILLMENT_CORRECTION", id: correction.id }))).toBe("BUSINESS_INVARIANT"); // 이미 재개되어 종결 상태가 아니다
  });

  it("종결 뒤 결제 정정으로 잔액이 생기면 재개한다", async () => {
    const closed = await closedOrder(10);
    const correction = await correctPay(closed.paymentId!, "5000");
    const reopening = await reopen(closed.orderId, { kind: "PAYMENT_CORRECTION", id: correction.id });
    expect(reopening.blockers.length).toBeGreaterThan(0);
    expect((await orderState(closed.orderId)).closed_at).toBeNull();
  });
});
