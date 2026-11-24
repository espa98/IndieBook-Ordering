import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { PaymentVoidRepository } from "./voidPayment";
import type { PaymentRepository } from "./recordPayment";

/**
 * 결제 확인 기록 (추가 전용, ST-Y02). 직원이 외부 증빙(승인 사실·입금 내역)을 확인했다는 사실이며
 * 결제 제공사(PG/VAN)가 검증했다는 뜻이 아니다 (DEC-06, P0는 수기 증빙 기록).
 */
export type PaymentConfirmation = {
  id: string;
  tenantId: string;
  paymentId: string;
  evidence: string;
  confirmedBy: string;
  confirmedAt: string;
  verificationSource: "STAFF_MANUAL_EVIDENCE";
  recordedAt: string;
};

export type PaymentConfirmationRepository = {
  list(tenantId: string, paymentId: string): PaymentConfirmation[];
  save(confirmation: PaymentConfirmation): void;
};

export type ConfirmPaymentDeps = {
  payments: PaymentRepository;
  paymentConfirmations: PaymentConfirmationRepository;
  paymentVoids: Pick<PaymentVoidRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ConfirmPaymentRequest = {
  tenantId: string;
  paymentId: string;
  evidence: string;
  confirmedBy: string;
  confirmedAt: string;
  idempotencyKey: string;
};

export function confirmPayment(
  deps: ConfirmPaymentDeps,
  request: ConfirmPaymentRequest,
): PaymentConfirmation {
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
      operation: "payment.confirm",
      key: request.idempotencyKey,
      payload: {
        paymentId: request.paymentId,
        evidence: request.evidence,
        confirmedBy: request.confirmedBy,
        confirmedAt: request.confirmedAt,
      },
    },
    () => {
      const payment = deps.payments.get(request.tenantId, request.paymentId);
      if (!payment) {
        throw new AppError("NOT_FOUND");
      }
      if (deps.paymentVoids.list(request.tenantId, payment.id).length > 0) {
        throw new AppError("BUSINESS_INVARIANT", "a voided payment cannot be confirmed");
      }
      if (deps.paymentConfirmations.list(request.tenantId, payment.id).length > 0) {
        throw new AppError("BUSINESS_INVARIANT", "payment is already confirmed");
      }
      const confirmation: PaymentConfirmation = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        paymentId: payment.id,
        evidence: request.evidence,
        confirmedBy: request.confirmedBy,
        confirmedAt: request.confirmedAt,
        verificationSource: "STAFF_MANUAL_EVIDENCE",
        recordedAt: now.toISOString(),
      };
      deps.paymentConfirmations.save(confirmation);
      return confirmation;
    },
  );
}
