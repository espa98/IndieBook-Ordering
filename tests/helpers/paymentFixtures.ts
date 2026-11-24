import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type {
  PaymentVoid,
  VoidPaymentRequest,
} from "../../src/payment/voidPayment";
import type {
  ConfirmPaymentRequest,
  PaymentConfirmation,
} from "../../src/payment/confirmPayment";
import type {
  Payment,
  RecordPaymentRequest,
} from "../../src/payment/recordPayment";
import { recordPayment } from "../../src/payment/recordPayment";
import { world } from "./procurementWorld";

export function createInMemoryPaymentRepository() {
  const all: Payment[] = [];
  return {
    get(tenantId: string, id: string): Payment | undefined {
      return all.find((p) => p.tenantId === tenantId && p.id === id);
    },
    list(tenantId: string, orderId: string): Payment[] {
      return all.filter((p) => p.tenantId === tenantId && p.orderId === orderId);
    },
    listByTenant(tenantId: string): Payment[] {
      return all.filter((p) => p.tenantId === tenantId);
    },
    save(payment: Payment): void {
      all.push(payment);
    },
  };
}

/** 확정 주문(book-1 2권 × 15,000원 = 30,000원)과 결제 기록 저장소가 있는 세계 */
export function paymentScene() {
  const w = world();
  const order = w.addOrder([{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }]);
  const payments = createInMemoryPaymentRepository();
  const deps = {
    orders: w.deps.orders,
    payments,
    idempotency: createIdempotencyStore(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const paymentRequest = (
    extra: Partial<RecordPaymentRequest> = {},
  ): RecordPaymentRequest => ({
    tenantId: "tenant-a",
    orderId: order.id,
    method: "BANK_TRANSFER",
    amountKrw: "10000",
    externalReference: `BANK-${++seq}`,
    paidAt: "2026-03-04T06:00:00.000Z",
    recordedBy: "김직원",
    idempotencyKey: `pay-${seq}`,
    ...extra,
  });
  return { w, order, deps, payments, paymentRequest };
}

export function createInMemoryPaymentConfirmationRepository() {
  const all: PaymentConfirmation[] = [];
  return {
    list(tenantId: string, paymentId: string): PaymentConfirmation[] {
      return all.filter((c) => c.tenantId === tenantId && c.paymentId === paymentId);
    },
    save(confirmation: PaymentConfirmation): void {
      all.push(confirmation);
    },
  };
}

/** paymentScene에서 계좌이체 10,000원이 입력된(확인 전) 세계 */
export function confirmationScene() {
  const s = paymentScene();
  const paymentConfirmations = createInMemoryPaymentConfirmationRepository();
  const paymentVoids = createInMemoryPaymentVoidRepository();
  const deps = { ...s.deps, paymentConfirmations, paymentVoids };
  const payment = recordPayment(deps, s.paymentRequest({ amountKrw: "10000", externalReference: "TX-C1" }));
  let seq = 0;
  const confirmRequest = (
    extra: Partial<ConfirmPaymentRequest> = {},
  ): ConfirmPaymentRequest => ({
    tenantId: "tenant-a",
    paymentId: payment.id,
    evidence: "계좌 입금 내역 캡처 2026-03-04, 입금자명 일치",
    confirmedBy: "김직원",
    confirmedAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: `pcf-${++seq}`,
    ...extra,
  });
  return { ...s, deps, payment, paymentConfirmations, paymentVoids, confirmRequest };
}

export function createInMemoryPaymentVoidRepository() {
  const all: PaymentVoid[] = [];
  return {
    list(tenantId: string, paymentId: string): PaymentVoid[] {
      return all.filter((v) => v.tenantId === tenantId && v.paymentId === paymentId);
    },
    save(paymentVoid: PaymentVoid): void {
      all.push(paymentVoid);
    },
  };
}

/** confirmationScene(확인 전 거래 1건)에서 무효 처리를 할 수 있는 세계 */
export function voidScene() {
  const s = confirmationScene();
  const { paymentVoids, deps } = s;
  let seq = 0;
  const voidRequest = (
    extra: Partial<VoidPaymentRequest> = {},
  ): VoidPaymentRequest => ({
    tenantId: "tenant-a",
    paymentId: s.payment.id,
    reason: "실제 입금이 확인되지 않아 오입력으로 무효 처리",
    voidedBy: "김직원",
    voidedAt: "2026-03-04T06:40:00.000Z",
    idempotencyKey: `pvd-${++seq}`,
    ...extra,
  });
  return { ...s, deps, paymentVoids, voidRequest };
}
