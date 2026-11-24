import { reserveStock } from "../../src/inventory/reserveStock";
import { confirmPayment } from "../../src/payment/confirmPayment";
import { recordPayment } from "../../src/payment/recordPayment";
import type {
  Fulfillment,
  PostFulfillmentRequest,
} from "../../src/fulfillment/postFulfillment";
import { releaseScene } from "./inventoryFixtures";
import {
  createInMemoryPaymentConfirmationRepository,
  createInMemoryPaymentRepository,
  createInMemoryPaymentVoidRepository,
} from "./paymentFixtures";
import { adjustScene } from "./stockFixtures";

export function createInMemoryFulfillmentRepository() {
  const all: Fulfillment[] = [];
  return {
    list(tenantId: string, orderId: string): Fulfillment[] {
      return all.filter((f) => f.tenantId === tenantId && f.orderId === orderId);
    },
    save(fulfillment: Fulfillment): void {
      all.push(fulfillment);
    },
  };
}

/** 취소 요청으로 인도가 잠긴 수량 (취소 요청 모델 ST-O05/D27이 생기기 전의 연결점) */
export function createInMemoryOrderCancelLockRepository() {
  const all: { tenantId: string; orderId: string; orderLineId: string; quantity: number }[] = [];
  return {
    list(tenantId: string, orderId: string, orderLineId: string) {
      return all.filter(
        (l) => l.tenantId === tenantId && l.orderId === orderId && l.orderLineId === orderLineId,
      );
    },
    lock(tenantId: string, orderId: string, orderLineId: string, quantity: number) {
      all.push({ tenantId, orderId, orderLineId, quantity });
    },
  };
}

/**
 * 주문 D(book-1 2권 × 15,000원)가 매장 재고 2권을 예약했고,
 * 주문 B(3권 × 15,000원)는 입고 배분 3권이 있는 세계. 결제는 아직 없다.
 */
export function fulfillmentScene() {
  const rel = releaseScene(); // 주문 A/B/C, 입고 배분(주문 B 3권)
  const st = adjustScene(); // book-1 재고 5권
  const payments = createInMemoryPaymentRepository();
  const paymentConfirmations = createInMemoryPaymentConfirmationRepository();
  const paymentVoids = createInMemoryPaymentVoidRepository();
  const fulfillments = createInMemoryFulfillmentRepository();
  const orderCancelLocks = createInMemoryOrderCancelLockRepository();
  const deps = {
    ...st.deps,
    ...rel.deps,
    orders: rel.w.deps.orders,
    sourcingAllocations: rel.w.deps.allocations,
    payments,
    paymentConfirmations,
    paymentVoids,
    fulfillments,
    orderCancelLocks,
  };
  const orderD = rel.w.addOrder([{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }]);
  const reservation = reserveStock(deps, {
    tenantId: "tenant-a",
    orderId: orderD.id,
    orderLineId: orderD.lines[0]!.lineId,
    quantity: 2,
    reservedBy: "김직원",
    reservedAt: "2026-03-04T06:40:00.000Z",
    idempotencyKey: "res-D",
  });
  let seq = 0;
  /** 주문에 외부 결제 사실을 입력하고 직원이 확인한 상태로 만든다 */
  const pay = (orderId: string, amountKrw: string, confirmed = true) => {
    const payment = recordPayment(deps, {
      tenantId: "tenant-a",
      orderId,
      method: "BANK_TRANSFER",
      amountKrw,
      externalReference: `TX-F${++seq}`,
      paidAt: "2026-03-04T06:00:00.000Z",
      recordedBy: "김직원",
      idempotencyKey: `pay-F${seq}`,
    });
    if (confirmed) {
      confirmPayment(deps, {
        tenantId: "tenant-a",
        paymentId: payment.id,
        evidence: "입금 내역 확인",
        confirmedBy: "김직원",
        confirmedAt: "2026-03-04T06:30:00.000Z",
        idempotencyKey: `pcf-F${seq}`,
      });
    }
    return payment;
  };
  const fulfillRequest = (
    extra: Partial<PostFulfillmentRequest> = {},
  ): PostFulfillmentRequest => ({
    tenantId: "tenant-a",
    orderId: orderD.id,
    orderLineId: orderD.lines[0]!.lineId,
    sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }],
    receivedBy: "김직원",
    receivedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `ful-${++seq}`,
    ...extra,
  });
  return { ...rel, deps, orderD, reservation, pay, fulfillRequest, fulfillments, orderCancelLocks, st };
}
