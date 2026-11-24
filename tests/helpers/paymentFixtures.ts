import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type {
  CorrectPaymentRequest,
  PaymentCorrection,
} from "../../src/payment/correctPayment";
import type {
  ConfirmRefundRequest,
  RefundConfirmation,
} from "../../src/payment/confirmRefund";
import { openRefundTask } from "../../src/payment/openRefundTask";
import type {
  OpenRefundTaskRequest,
  RefundTask,
} from "../../src/payment/openRefundTask";
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
import { confirmPayment } from "../../src/payment/confirmPayment";
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

export function createInMemoryRefundTaskRepository() {
  const all: RefundTask[] = [];
  return {
    get(tenantId: string, id: string): RefundTask | undefined {
      return all.find((t) => t.tenantId === tenantId && t.id === id);
    },
    list(tenantId: string, orderId: string): RefundTask[] {
      return all.filter((t) => t.tenantId === tenantId && t.orderId === orderId);
    },
    save(task: RefundTask): void {
      all.push(task);
    },
  };
}

/** 총액 30,000원 주문에 10,000원 + 25,000원이 모두 확인되어 5,000원이 과수납인 세계 */
export function overpaidScene() {
  const s = voidScene();
  const refundTasks = createInMemoryRefundTaskRepository();
  const refundConfirmations = createInMemoryRefundConfirmationRepository();
  const deps = { ...s.deps, refundTasks, refundConfirmations };
  confirmPayment(deps, s.confirmRequest({ paymentId: s.payment.id }));
  const second = recordPayment(
    deps,
    s.paymentRequest({ method: "CARD", amountKrw: "25000", externalReference: "CARD-OP" }),
  );
  confirmPayment(deps, s.confirmRequest({ paymentId: second.id }));
  let seq = 0;
  const openRequest = (
    extra: Partial<OpenRefundTaskRequest> = {},
  ): OpenRefundTaskRequest => ({
    tenantId: "tenant-a",
    orderId: s.order.id,
    openedBy: "김직원",
    openedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: `rft-${++seq}`,
    ...extra,
  });
  return { ...s, deps, refundTasks, refundConfirmations, first: s.payment, second, openRequest };
}

export function createInMemoryRefundConfirmationRepository() {
  const all: RefundConfirmation[] = [];
  return {
    list(tenantId: string, refundTaskId: string): RefundConfirmation[] {
      return all.filter((r) => r.tenantId === tenantId && r.refundTaskId === refundTaskId);
    },
    listByOrder(tenantId: string, orderId: string): RefundConfirmation[] {
      return all.filter((r) => r.tenantId === tenantId && r.orderId === orderId);
    },
    listByPayment(tenantId: string, paymentId: string): RefundConfirmation[] {
      return all.filter((r) => r.tenantId === tenantId && r.paymentId === paymentId);
    },
    save(refund: RefundConfirmation): void {
      all.push(refund);
    },
  };
}

/** overpaidScene에서 환급 필요 업무(5,000원)가 열린 세계 */
export function refundScene() {
  const s = overpaidScene();
  const { refundConfirmations, deps } = s;
  const task = openRefundTask(deps, s.openRequest({ idempotencyKey: "rft-scene" }));
  let seq = 0;
  const refundRequest = (
    extra: Partial<ConfirmRefundRequest> = {},
  ): ConfirmRefundRequest => ({
    tenantId: "tenant-a",
    refundTaskId: task.id,
    paymentId: s.second.id,
    amountKrw: "3000",
    evidence: "카드사 부분 취소 승인 내역 2026-03-05",
    actorRole: "OWNER",
    confirmedBy: "점주",
    confirmedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `rfc-${++seq}`,
    ...extra,
  });
  return { ...s, deps, task, refundConfirmations, refundRequest };
}

/** 총액 30,000원 주문에 20,000원 결제 3건이 모두 확인되어 30,000원이 과수납이고 환급 업무가 열린 세계 */
export function heavilyOverpaidScene() {
  const s = confirmationScene();
  const refundTasks = createInMemoryRefundTaskRepository();
  const refundConfirmations = createInMemoryRefundConfirmationRepository();
  const deps = { ...s.deps, refundTasks, refundConfirmations };
  const payments = [1, 2, 3].map((n) => {
    const payment = recordPayment(
      deps,
      s.paymentRequest({ method: "BANK_TRANSFER", amountKrw: "20000", externalReference: `HEAVY-${n}`, idempotencyKey: `heavy-p${n}` }),
    );
    confirmPayment(deps, s.confirmRequest({ paymentId: payment.id, idempotencyKey: `heavy-c${n}` }));
    return payment;
  });
  const task = openRefundTask(deps, {
    tenantId: "tenant-a",
    orderId: s.order.id,
    openedBy: "김직원",
    openedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: "heavy-task",
  });
  let seq = 0;
  const refundRequest = (
    extra: Partial<ConfirmRefundRequest> = {},
  ): ConfirmRefundRequest => ({
    tenantId: "tenant-a",
    refundTaskId: task.id,
    paymentId: payments[0]!.id,
    amountKrw: "1000",
    evidence: "은행 환불 이체 내역",
    actorRole: "OWNER",
    confirmedBy: "점주",
    confirmedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `heavy-r${++seq}`,
    ...extra,
  });
  return { ...s, deps, payments, task, refundConfirmations, refundRequest };
}

export function createInMemoryPaymentCorrectionRepository() {
  const all: PaymentCorrection[] = [];
  return {
    list(tenantId: string, paymentId: string): PaymentCorrection[] {
      return all.filter((c) => c.tenantId === tenantId && c.paymentId === paymentId);
    },
    listByOrder(tenantId: string, orderId: string): PaymentCorrection[] {
      return all.filter((c) => c.tenantId === tenantId && c.orderId === orderId);
    },
    save(correction: PaymentCorrection): void {
      all.push(correction);
    },
  };
}

/** overpaidScene(확인 결제 10,000원 + 25,000원)에서 확인된 거래를 정정하는 세계 */
export function paymentCorrectionScene() {
  const s = overpaidScene();
  const paymentCorrections = createInMemoryPaymentCorrectionRepository();
  const deps = { ...s.deps, paymentCorrections };
  let seq = 0;
  const correctPaymentRequest = (
    extra: Partial<CorrectPaymentRequest> = {},
  ): CorrectPaymentRequest => ({
    tenantId: "tenant-a",
    paymentId: s.first.id,
    reducedKrw: "2000",
    reason: "입금액을 10,000원으로 잘못 입력 (실제 8,000원)",
    evidence: "은행 입금 내역 재확인 2026-03-05",
    actorRole: "OWNER",
    correctedBy: "점주",
    correctedAt: "2026-03-04T06:55:00.000Z",
    idempotencyKey: `pcr-${++seq}`,
    ...extra,
  });
  return { ...s, deps, paymentCorrections, correctPaymentRequest };
}
