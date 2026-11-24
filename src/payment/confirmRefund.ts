import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { PaymentCorrectionRepository } from "./correctPayment";
import type { PaymentConfirmationRepository } from "./confirmPayment";
import type { PaymentVoidRepository } from "./voidPayment";
import type { RefundTaskRepository } from "./openRefundTask";
import type { PaymentRepository } from "./recordPayment";

/**
 * 환급 확인 기록 (추가 전용, ST-Y06). 외부(카드사·은행)에서 실제 환급이 끝났다는 사실을 증빙과 함께 남긴다.
 * 이 시스템이 환급을 실행하거나 제공사가 검증했다는 뜻이 아니다 (DEC-06).
 */
export type RefundConfirmation = {
  id: string;
  tenantId: string;
  refundTaskId: string;
  orderId: string;
  /** 환급 대상이 되는 원 결제 (BR-Y08: 원 결제별 상한) */
  paymentId: string;
  amountKrw: string;
  evidence: string;
  confirmedBy: string;
  confirmedAt: string;
  /** 요청·승인 경로로 생긴 기록이면 원 요청 참조 */
  refundRequestId?: string;
  verificationSource: "STAFF_MANUAL_EVIDENCE";
  recordedAt: string;
};

export type RefundConfirmationRepository = {
  list(tenantId: string, refundTaskId: string): RefundConfirmation[];
  listByOrder(tenantId: string, orderId: string): RefundConfirmation[];
  listByPayment(tenantId: string, paymentId: string): RefundConfirmation[];
  save(refund: RefundConfirmation): void;
};

export type ConfirmRefundDeps = {
  refundTasks: RefundTaskRepository;
  payments: PaymentRepository;
  paymentConfirmations: Pick<PaymentConfirmationRepository, "list">;
  paymentVoids: Pick<PaymentVoidRepository, "list">;
  paymentCorrections: Pick<PaymentCorrectionRepository, "list">;
  refundConfirmations: RefundConfirmationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ConfirmRefundRequest = {
  tenantId: string;
  refundTaskId: string;
  paymentId: string;
  amountKrw: string;
  evidence: string;
  actorRole: "OWNER" | "STAFF";
  confirmedBy: string;
  confirmedAt: string;
  refundRequestId?: string;
  idempotencyKey: string;
};

export function confirmRefund(
  deps: ConfirmRefundDeps,
  request: ConfirmRefundRequest,
): RefundConfirmation {
  // 환급 확인은 Owner 승인 업무다 (DEC-09)
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (typeof request.amountKrw !== "string" || !/^[1-9]\d*$/.test(request.amountKrw)) {
    invalid("amountKrw", "must be a positive integer string in KRW");
  }
  for (const field of ["evidence", "confirmedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("confirmedAt", request.confirmedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.confirm-refund",
      key: request.idempotencyKey,
      payload: {
        refundTaskId: request.refundTaskId,
        paymentId: request.paymentId,
        amountKrw: request.amountKrw,
        evidence: request.evidence,
        confirmedBy: request.confirmedBy,
        confirmedAt: request.confirmedAt,
      },
    },
    () => {
      const task = deps.refundTasks.get(request.tenantId, request.refundTaskId);
      if (!task) {
        throw new AppError("NOT_FOUND");
      }
      const payment = deps.payments.get(request.tenantId, request.paymentId);
      if (!payment) {
        throw new AppError("NOT_FOUND");
      }
      // 환급 대상은 이 주문의, 직원이 확인했고 무효가 아닌 원 결제여야 한다 (BR-Y08)
      if (
        payment.orderId !== task.orderId ||
        deps.paymentConfirmations.list(request.tenantId, payment.id).length === 0 ||
        deps.paymentVoids.list(request.tenantId, payment.id).length > 0
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "the refunded payment must be a confirmed, non-voided payment of this order",
        );
      }
      const amount = BigInt(request.amountKrw);
      const sum = (items: readonly { amountKrw: string }[]) =>
        items.reduce((total, i) => total + BigInt(i.amountKrw), 0n);
      const taskRemaining =
        BigInt(task.requiredKrw) - sum(deps.refundConfirmations.list(request.tenantId, task.id));
      const paymentAvailable =
        BigInt(payment.amountKrw) -
        deps.paymentCorrections
          .list(request.tenantId, payment.id)
          .reduce((total, c) => total + BigInt(c.reducedKrw), 0n) -
        sum(deps.refundConfirmations.listByPayment(request.tenantId, payment.id));
      if (amount > taskRemaining || amount > paymentAvailable) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "refund must not exceed the task's remaining amount or the original payment's available amount",
        );
      }
      const refund: RefundConfirmation = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        refundTaskId: task.id,
        orderId: task.orderId,
        paymentId: payment.id,
        amountKrw: request.amountKrw,
        evidence: request.evidence,
        confirmedBy: request.confirmedBy,
        confirmedAt: request.confirmedAt,
        ...(request.refundRequestId === undefined ? {} : { refundRequestId: request.refundRequestId }),
        verificationSource: "STAFF_MANUAL_EVIDENCE",
        recordedAt: now.toISOString(),
      };
      deps.refundConfirmations.save(refund);
      return refund;
    },
  );
}
