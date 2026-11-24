import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { PaymentConfirmationRepository } from "./confirmPayment";
import type { RefundConfirmationRepository } from "./confirmRefund";
import type { PaymentCorrectionRepository } from "./correctPayment";
import type { PaymentVoidRepository } from "./voidPayment";
import type { RefundTaskRepository } from "./openRefundTask";
import type { PaymentRepository } from "./recordPayment";

/**
 * 환급 완료 확인 요청 (추가 전용). Staff가 외부에서 실제 환급이 끝난 증빙과 함께 요청하며,
 * 환급 원장은 Owner 승인에서만 기록된다 (DEC-09).
 */
export type RefundRequest = {
  id: string;
  tenantId: string;
  refundTaskId: string;
  orderId: string;
  paymentId: string;
  amountKrw: string;
  evidence: string;
  requestedBy: string;
  requestedAt: string;
  recordedAt: string;
};

export type RefundRequestDecisionKind = "APPROVED" | "REJECTED" | "WITHDRAWN";

export type RefundRequestDecision = {
  id: string;
  tenantId: string;
  requestId: string;
  kind: RefundRequestDecisionKind;
  decidedBy: string;
  decidedAt: string;
  recordedAt: string;
};

export type RefundRequestRepository = {
  get(tenantId: string, id: string): RefundRequest | undefined;
  list(tenantId: string, refundTaskId: string): RefundRequest[];
  save(request: RefundRequest): void;
};

export type RefundRequestDecisionRepository = {
  list(tenantId: string, requestId: string): RefundRequestDecision[];
  save(decision: RefundRequestDecision): void;
};

/** 요청 상태는 결정 기록에서 파생한다. 결정이 없으면 REQUESTED(진행 중)다. */
export function refundRequestStatus(
  decisions: readonly RefundRequestDecision[],
): "REQUESTED" | RefundRequestDecisionKind {
  return decisions.length === 0 ? "REQUESTED" : decisions[decisions.length - 1]!.kind;
}

export type RequestRefundDeps = {
  refundTasks: RefundTaskRepository;
  payments: PaymentRepository;
  paymentConfirmations: Pick<PaymentConfirmationRepository, "list">;
  paymentVoids: Pick<PaymentVoidRepository, "list">;
  paymentCorrections: Pick<PaymentCorrectionRepository, "list">;
  refundConfirmations: Pick<RefundConfirmationRepository, "list" | "listByPayment">;
  refundRequests: RefundRequestRepository;
  refundRequestDecisions: Pick<RefundRequestDecisionRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RequestRefundRequest = {
  tenantId: string;
  refundTaskId: string;
  paymentId: string;
  amountKrw: string;
  evidence: string;
  requestedBy: string;
  requestedAt: string;
  idempotencyKey: string;
};

export function requestRefund(
  deps: RequestRefundDeps,
  request: RequestRefundRequest,
): RefundRequest {
  if (typeof request.amountKrw !== "string" || !/^[1-9]\d*$/.test(request.amountKrw)) {
    invalid("amountKrw", "must be a positive integer string in KRW");
  }
  for (const field of ["evidence", "requestedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("requestedAt", request.requestedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.request-refund",
      key: request.idempotencyKey,
      payload: {
        refundTaskId: request.refundTaskId,
        paymentId: request.paymentId,
        amountKrw: request.amountKrw,
        evidence: request.evidence,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
      },
    },
    () => {
      const task = deps.refundTasks.get(request.tenantId, request.refundTaskId);
      const payment = deps.payments.get(request.tenantId, request.paymentId);
      if (!task || !payment) {
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
      // 한도: 확정 환급뿐 아니라 진행 중(REQUESTED)인 다른 요청의 금액도 예약으로 본다 (BR-Y08)
      const sumAmount = (items: readonly { amountKrw: string }[]) =>
        items.reduce((total, i) => total + BigInt(i.amountKrw), 0n);
      const active = deps.refundRequests
        .list(request.tenantId, task.id)
        .filter(
          (r) =>
            refundRequestStatus(deps.refundRequestDecisions.list(request.tenantId, r.id)) === "REQUESTED",
        );
      const taskRemaining =
        BigInt(task.requiredKrw) -
        sumAmount(deps.refundConfirmations.list(request.tenantId, task.id)) -
        sumAmount(active);
      const corrected = deps.paymentCorrections
        .list(request.tenantId, payment.id)
        .reduce((total, c) => total + BigInt(c.reducedKrw), 0n);
      const paymentAvailable =
        BigInt(payment.amountKrw) -
        corrected -
        sumAmount(deps.refundConfirmations.listByPayment(request.tenantId, payment.id)) -
        sumAmount(active.filter((r) => r.paymentId === payment.id));
      if (BigInt(request.amountKrw) > taskRemaining || BigInt(request.amountKrw) > paymentAvailable) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "refund request must not exceed the task's or the payment's remaining amount including pending requests",
        );
      }
      const refundRequest: RefundRequest = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        refundTaskId: task.id,
        orderId: task.orderId,
        paymentId: payment.id,
        amountKrw: request.amountKrw,
        evidence: request.evidence,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        recordedAt: now.toISOString(),
      };
      deps.refundRequests.save(refundRequest);
      return refundRequest;
    },
  );
}
