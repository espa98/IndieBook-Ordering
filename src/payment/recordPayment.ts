import { AppError } from "../errors/AppError";
import { assertOrderOpenForTransactions } from "../order/orderGuards";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "../order/confirmOrderService";

export const PAYMENT_METHODS = ["CARD", "EASY_PAY", "BANK_TRANSFER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * 외부에서 실제로 일어난 결제 거래 사실의 입력 기록 (추가 전용, ST-Y01).
 * 이 시스템은 PG 승인을 실행하지 않으며, 확인·무효는 별도 기록으로 파생한다.
 */
export type Payment = {
  id: string;
  tenantId: string;
  orderId: string;
  method: PaymentMethod;
  /** 원화 정수 문자열 */
  amountKrw: string;
  /** 승인번호·입금 참조 등 외부 거래 식별값 */
  externalReference: string;
  /** 업무 발생 시각: 실제 결제·입금 시각 */
  paidAt: string;
  recordedBy: string;
  /** 서버 기록 시각 */
  recordedAt: string;
};

export type PaymentRepository = {
  get(tenantId: string, id: string): Payment | undefined;
  list(tenantId: string, orderId: string): Payment[];
  listByTenant(tenantId: string): Payment[];
  save(payment: Payment): void;
};

export type RecordPaymentDeps = {
  orders: OrderRepository;
  payments: PaymentRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RecordPaymentRequest = {
  tenantId: string;
  orderId: string;
  method: PaymentMethod;
  amountKrw: string;
  externalReference: string;
  paidAt: string;
  recordedBy: string;
  idempotencyKey: string;
};

export function recordPayment(
  deps: RecordPaymentDeps,
  request: RecordPaymentRequest,
): Payment {
  if (!PAYMENT_METHODS.includes(request.method)) {
    invalid("method", "must be CARD, EASY_PAY or BANK_TRANSFER");
  }
  if (typeof request.amountKrw !== "string" || !/^[1-9]\d*$/.test(request.amountKrw)) {
    invalid("amountKrw", "must be a positive integer string in KRW");
  }
  for (const field of ["externalReference", "recordedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("paidAt", request.paidAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.record",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        method: request.method,
        amountKrw: request.amountKrw,
        externalReference: request.externalReference,
        paidAt: request.paidAt,
        recordedBy: request.recordedBy,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) {
        // 없는 주문과 타 테넌트의 주문은 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      assertOrderOpenForTransactions(order, "recording a payment");
      // 같은 외부 거래를 두 번 기록하면 매출·환급이 이중으로 잡힌다 (DEC-14)
      const reference = request.externalReference.trim();
      if (
        deps.payments
          .listByTenant(request.tenantId)
          .some((p) => p.method === request.method && p.externalReference === reference)
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "this external transaction is already recorded",
        );
      }
      const payment: Payment = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: request.orderId,
        method: request.method,
        amountKrw: request.amountKrw,
        externalReference: reference,
        paidAt: request.paidAt,
        recordedBy: request.recordedBy,
        recordedAt: now.toISOString(),
      };
      deps.payments.save(payment);
      return payment;
    },
  );
}
