import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOSURE_SWEEP_LOCK_KEY, createClosureSweeper } from "../../src/jobs/closureSweeper";
import { createPgCancellationApi } from "../../src/db/pgCancellationApi";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
import { createPgProcurementApi } from "../../src/db/pgProcurementApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER_A]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T_A, OWNER_A, STAFF_A]);
  await c.query(`insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel, version) values ($1, 'sup-a', true, '공급처 A', 'EMAIL', 1)`, [T_A]);
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
const key = () => `sw-${++seq}`;
const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const sweeper = (overrides: Partial<Parameters<typeof createClosureSweeper>[0]> = {}) =>
  createClosureSweeper({
    pool: db.pool(),
    cancellations: createPgCancellationApi({ pool: db.pool() }),
    procurement: createPgProcurementApi({ pool: db.pool() }),
    ...overrides,
  });

/** 확정 주문(품목 1개)에 재고를 예약하고, `paid`면 전액 결제 확인, `deliver`면 전량 인도, `close`면 종결 요청까지 한다 */
async function order(book: number, options: { deliver?: boolean; close?: boolean } = {}) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity: 1, unitPriceKrw: "15000" }] });
  const confirmed = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = confirmed.lines[0]!.lineId;
  await rows(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', 1, '초기 재고', 'seed', now())`, [T_A, BOOK(book)]);
  const reservation = await createPgStockApi({ pool: db.pool() }).reserveStock(owner, { tenantId: T_A, orderId: confirmed.id, orderLineId: lineId, quantity: 1, reservedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });
  const pay = createPgPaymentApi({ pool: db.pool() });
  const payment = await pay.recordPayment(staff, { tenantId: T_A, orderId: confirmed.id, method: "BANK_TRANSFER", amountKrw: "15000", externalReference: `SW-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
  await pay.confirmPayment(staff, { tenantId: T_A, paymentId: payment.id, evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
  let fulfillmentId: string | undefined;
  if (options.deliver) {
    fulfillmentId = (await createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, {
      tenantId: T_A, orderId: confirmed.id, orderLineId: lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }], receivedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: key(),
    })).id;
  }
  let closureRequestId: string | undefined;
  if (options.close) {
    closureRequestId = (await createPgCancellationApi({ pool: db.pool() }).requestOrderClosure(staff, { tenantId: T_A, orderId: confirmed.id, expectedVersion: 2, requestedAt: "2026-03-04T06:58:00.000Z", idempotencyKey: key() })).id;
  }
  return { orderId: confirmed.id, lineId, reservationId: reservation.id, fulfillmentId, closureRequestId };
};
const closedAt = async (orderId: string) => (await rows("select closed_at from public.ordering_orders where id = $1", [orderId]))[0].closed_at as Date | null;

/** 확정 주문 → 배정 → 발주 → 전달(SENT)까지. `receive`면 발주 수량을 모두 입고한다 */
async function purchaseOrder(book: number, options: { receive?: boolean } = {}) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity: 2, unitPriceKrw: "15000" }] });
  const confirmed = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const api = createPgProcurementApi({ pool: db.pool() });
  const allocation = await api.allocateSourcing(staff, { tenantId: T_A, orderId: confirmed.id, lineId: confirmed.lines[0]!.lineId, supplierCode: "sup-a", quantity: 2, idempotencyKey: key() });
  const po = await api.createPurchaseOrder(staff, { tenantId: T_A, supplierCode: "sup-a", allocationIds: [allocation.id], idempotencyKey: key() });
  await api.markPurchaseOrderReady(staff, { tenantId: T_A, purchaseOrderId: po.id, expectedVersion: 1, idempotencyKey: key() });
  await api.recordPurchaseOrderDelivery(staff, { tenantId: T_A, purchaseOrderId: po.id, expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T06:10:00.000Z", idempotencyKey: key() });
  if (options.receive) {
    await createPgReceivingApi({ pool: db.pool() }).receiveGoods(staff, { tenantId: T_A, purchaseOrderId: po.id, poLineId: po.lines[0]!.poLineId, normalQuantity: 2, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() });
  }
  return po.id;
};
const poStatus = async (id: string) => (await rows("select status from public.ordering_purchase_orders where id = $1", [id]))[0].status as string;

describe("종결 스위퍼: 주문 종결", () => {
  it("종결 요청이 있고 조건을 채운 주문은 종결하고, 조건이 안 된 주문은 차단 사유와 함께 남기며, 낡은 요청은 건드리지 않고, 다시 돌려도 달라지지 않는다", async () => {
    const ready = await order(1, { deliver: true, close: true });
    const blocked = await order(2, { close: true }); // 미인도
    const stale = await order(3, { deliver: true, close: true });
    await rows("update public.ordering_orders set version = version + 1 where id = $1", [stale.orderId]); // 요청 뒤 version이 바뀌었다
    const noRequest = await order(4, { deliver: true }); // 종결 요청이 없다

    const first = await sweeper().runOnce();

    expect(first.skipped).toBe(false);
    expect(first.orders).toMatchObject({ closed: 1, blocked: 1, failed: 0 });
    expect(first.orders.blockedDetails).toEqual([expect.objectContaining({ orderId: blocked.orderId, detail: expect.stringContaining("UNDELIVERED") })]);
    expect(await closedAt(ready.orderId)).not.toBeNull();
    expect(await closedAt(blocked.orderId)).toBeNull();
    expect(await closedAt(stale.orderId)).toBeNull(); // 낡은 요청은 다시 요청해야 한다
    expect(await closedAt(noRequest.orderId)).toBeNull(); // 요청 없이는 종결하지 않는다
    expect((await rows("select executed_by from public.ordering_order_closures where order_id = $1", [ready.orderId]))[0].executed_by).toBe("SYSTEM");

    const second = await sweeper().runOnce();
    expect(second.orders).toMatchObject({ closed: 0, blocked: 1, failed: 0 }); // 종결된 주문은 다시 대상이 아니다
  });
});

describe("종결 스위퍼: 발주 종결", () => {
  it("모두 입고된 발주는 종결하고 미입고 발주는 차단 사유와 함께 남긴다", async () => {
    const full = await purchaseOrder(5, { receive: true });
    const open = await purchaseOrder(6);

    const result = await sweeper().runOnce();

    expect(result.purchaseOrders.closed).toBeGreaterThanOrEqual(1);
    expect(await poStatus(full)).toBe("CLOSED");
    expect(await poStatus(open)).toBe("SENT");
    expect(result.purchaseOrders.blockedDetails).toContainEqual(expect.objectContaining({ purchaseOrderId: open, detail: expect.stringContaining("OPEN_QUANTITY") }));
    expect(result.purchaseOrders.blockedDetails.some((d) => d.purchaseOrderId === full)).toBe(false);
  });
});

describe("종결 스위퍼: 단일 실행과 장애 격리", () => {
  it("다른 실행이 락을 쥐고 있으면 건너뛰고, 한 건이 예기치 않게 실패해도 나머지는 계속 처리하며 실패로 센다", async () => {
    const holder = await db.connect();
    try {
      await holder.query("select pg_advisory_lock($1)", [CLOSURE_SWEEP_LOCK_KEY]);
      expect((await sweeper().runOnce()).skipped).toBe(true);
    } finally {
      await holder.query("select pg_advisory_unlock($1)", [CLOSURE_SWEEP_LOCK_KEY]);
      await holder.end();
    }

    const bad = await purchaseOrder(7, { receive: true });
    const good = await purchaseOrder(8, { receive: true });
    const real = createPgProcurementApi({ pool: db.pool() });
    const errors: unknown[] = [];
    const result = await sweeper({
      procurement: {
        executePurchaseOrderClosure: async (request) => {
          if (request.purchaseOrderId === bad) throw new Error("boom");
          return real.executePurchaseOrderClosure(request);
        },
      },
      logError: (error) => void errors.push(error),
    }).runOnce();

    expect(result.purchaseOrders.failed).toBe(1);
    expect(errors).toHaveLength(1);
    expect(await poStatus(good)).toBe("CLOSED");
    expect(await poStatus(bad)).toBe("SENT"); // 실패한 건은 그대로 남고 다음 실행에서 다시 시도한다
  });
});

describe("종결 스위퍼: 주문 재개", () => {
  it("종결 뒤에 기록된 정정으로 종결 조건이 깨진 주문을 재개하고, 이미 근거로 쓰인 정정은 다시 보지 않으며, 재개할 수 없는 정정은 변경 없음으로 센다", async () => {
    const target = await order(9, { deliver: true, close: true });
    expect((await sweeper().runOnce()).orders.closed).toBeGreaterThanOrEqual(1);
    expect(await closedAt(target.orderId)).not.toBeNull();
    await createPgFulfillmentApi({ pool: db.pool() }).correctFulfillment(owner, {
      tenantId: T_A, orderId: target.orderId, fulfillmentId: target.fulfillmentId!, quantity: 1,
      restorations: [{ kind: "STOCK_RESERVATION", sourceId: target.reservationId, quantity: 1 }],
      reason: "수령 오기록", evidence: "매장 반입 확인", physicalReturnConfirmed: true, correctedAt: "2026-03-04T07:30:00.000Z", idempotencyKey: key(),
    });

    const reopened = await sweeper().runOnce();

    expect(reopened.reopenings).toMatchObject({ reopened: 1, unchanged: 0, failed: 0 });
    expect(await closedAt(target.orderId)).toBeNull();
    expect((await rows("select trigger_kind, executed_by from public.ordering_order_reopenings where order_id = $1", [target.orderId]))[0]).toEqual({ trigger_kind: "FULFILLMENT_CORRECTION", executed_by: "SYSTEM" });
    expect((await sweeper().runOnce()).reopenings).toMatchObject({ attempted: 0, reopened: 0 }); // 이미 근거로 쓰인 정정은 후보가 아니다

    // 종결 조건이 그대로 충족되어 재개할 수 없는 경우는 변경 없음으로 센다
    const stuck = await order(10, { deliver: true, close: true });
    await sweeper().runOnce();
    await createPgFulfillmentApi({ pool: db.pool() }).correctFulfillment(owner, {
      tenantId: T_A, orderId: stuck.orderId, fulfillmentId: stuck.fulfillmentId!, quantity: 1,
      restorations: [{ kind: "STOCK_RESERVATION", sourceId: stuck.reservationId, quantity: 1 }],
      reason: "수령 오기록", evidence: "매장 반입 확인", physicalReturnConfirmed: true, correctedAt: "2026-03-04T07:30:00.000Z", idempotencyKey: key(),
    });
    const real = createPgCancellationApi({ pool: db.pool() });
    const unchanged = await sweeper({
      cancellations: {
        executeOrderClosure: (request) => real.executeOrderClosure(request),
        executeOrderReopening: async () => {
          throw new AppError("BUSINESS_INVARIANT", "closure conditions are still satisfied");
        },
      },
    }).runOnce();
    expect(unchanged.reopenings).toMatchObject({ reopened: 0, unchanged: 1, failed: 0 });
    expect(await closedAt(stuck.orderId)).not.toBeNull();
  });
});
