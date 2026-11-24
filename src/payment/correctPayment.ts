import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { PaymentConfirmationRepository } from "./confirmPayment";
import type { RefundConfirmationRepository } from "./confirmRefund";
import type { PaymentRepository } from "./recordPayment";

/**
 * 확인된 결제의 감액 보정 기록 (추가 전용, ST-Y04). 원거래를 수정·삭제하지 않고 보정 이벤트로 정정한다.
 * 실제 환급(ST-Y06)과 구분된다 — 오기록 정정은 돈이 오간 사실을 만들지 않는다.
 */
export type PaymentCorrection = {
  id: string;
  tenantId: string;
  orderId: string;
  paymentId: string;
  reducedKrw: string;
  reason: string;
  evidence: string;
  correctedBy: string;
  correctedAt: string;
  recordedAt: string;
};

export type PaymentCorrectionRepository = {
  get(tenantId: string, id: string): PaymentCorrection | undefined;
  list(tenantId: string, paymentId: string): PaymentCorrection[];
  listByOrder(tenantId: string, orderId: string): PaymentCorrection[];
  save(correction: PaymentCorrection): void;
};

export type CorrectPaymentDeps = {
  payments: PaymentRepository;
  paymentConfirmations: Pick<PaymentConfirmationRepository, "list">;
  refundConfirmations: Pick<RefundConfirmationRepository, "listByPayment">;
  paymentCorrections: PaymentCorrectionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CorrectPaymentRequest = {
  tenantId: string;
  paymentId: string;
  reducedKrw: string;
  reason: string;
  evidence: string;
  actorRole: "OWNER" | "STAFF";
  correctedBy: string;
  correctedAt: string;
  idempotencyKey: string;
};

export function correctPayment(
  deps: CorrectPaymentDeps,
  request: CorrectPaymentRequest,
): PaymentCorrection {
  if (typeof request.reducedKrw !== "string" || !/^[1-9]\d*$/.test(request.reducedKrw)) {
    invalid("reducedKrw", "must be a positive integer string in KRW");
  }
  for (const field of ["reason", "evidence", "correctedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("correctedAt", request.correctedAt, now);
  // 거래 정정은 Owner 승인 업무다 (DEC-09)
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.correct",
      key: request.idempotencyKey,
      payload: {
        paymentId: request.paymentId,
        reducedKrw: request.reducedKrw,
        reason: request.reason,
        evidence: request.evidence,
        correctedBy: request.correctedBy,
        correctedAt: request.correctedAt,
      },
    },
    () => {
      const payment = deps.payments.get(request.tenantId, request.paymentId);
      if (!payment) {
        throw new AppError("NOT_FOUND");
      }
      // 보정은 직원이 확인한 거래에만 한다. 확인 전 거래는 무효 처리(ST-Y03)로 다룬다
      if (deps.paymentConfirmations.list(request.tenantId, payment.id).length === 0) {
        throw new AppError("BUSINESS_INVARIANT", "only a confirmed payment can be corrected");
      }
      const sum = (items: readonly { amountKrw: string }[]) =>
        items.reduce((total, i) => total + BigInt(i.amountKrw), 0n);
      const corrected = deps.paymentCorrections
        .list(request.tenantId, payment.id)
        .reduce((total, c) => total + BigInt(c.reducedKrw), 0n);
      const refunded = sum(deps.refundConfirmations.listByPayment(request.tenantId, payment.id));
      // 누적 보정과 확정 환급의 합이 원 거래액을 넘을 수 없다 (BR-Y08)
      if (BigInt(request.reducedKrw) > BigInt(payment.amountKrw) - corrected - refunded) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "correction must not exceed the payment's remaining amount",
        );
      }
      const correction: PaymentCorrection = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: payment.orderId,
        paymentId: payment.id,
        reducedKrw: request.reducedKrw,
        reason: request.reason,
        evidence: request.evidence,
        correctedBy: request.correctedBy,
        correctedAt: request.correctedAt,
        recordedAt: now.toISOString(),
      };
      deps.paymentCorrections.save(correction);
      return correction;
    },
  );
}
