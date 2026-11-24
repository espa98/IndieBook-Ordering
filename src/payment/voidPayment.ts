import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { PaymentConfirmationRepository } from "./confirmPayment";
import type { PaymentRepository } from "./recordPayment";

/** 미확인 거래의 무효 기록 (추가 전용, ST-Y03). 원 거래 기록은 삭제하지 않는다. */
export type PaymentVoid = {
  id: string;
  tenantId: string;
  paymentId: string;
  reason: string;
  voidedBy: string;
  voidedAt: string;
  recordedAt: string;
};

export type PaymentVoidRepository = {
  list(tenantId: string, paymentId: string): PaymentVoid[];
  save(paymentVoid: PaymentVoid): void;
};

export type VoidPaymentDeps = {
  payments: PaymentRepository;
  paymentConfirmations: Pick<PaymentConfirmationRepository, "list">;
  paymentVoids: PaymentVoidRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type VoidPaymentRequest = {
  tenantId: string;
  paymentId: string;
  reason: string;
  voidedBy: string;
  voidedAt: string;
  idempotencyKey: string;
};

export function voidPayment(
  deps: VoidPaymentDeps,
  request: VoidPaymentRequest,
): PaymentVoid {
  for (const field of ["reason", "voidedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("voidedAt", request.voidedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.void",
      key: request.idempotencyKey,
      payload: {
        paymentId: request.paymentId,
        reason: request.reason,
        voidedBy: request.voidedBy,
        voidedAt: request.voidedAt,
      },
    },
    () => {
      const payment = deps.payments.get(request.tenantId, request.paymentId);
      if (!payment) {
        throw new AppError("NOT_FOUND");
      }
      // 확인된 거래의 오기록은 원거래를 보존하는 보정 거래로 다룬다 (ST-Y04). 무효는 미확인 거래만 가능하다
      if (
        deps.paymentConfirmations.list(request.tenantId, payment.id).length > 0 ||
        deps.paymentVoids.list(request.tenantId, payment.id).length > 0
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "only a payment that is neither confirmed nor voided can be voided",
        );
      }
      const paymentVoid: PaymentVoid = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        paymentId: payment.id,
        reason: request.reason,
        voidedBy: request.voidedBy,
        voidedAt: request.voidedAt,
        recordedAt: now.toISOString(),
      };
      deps.paymentVoids.save(paymentVoid);
      return paymentVoid;
    },
  );
}
