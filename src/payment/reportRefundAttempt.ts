import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { RefundTaskRepository } from "./openRefundTask";
import type { PaymentRepository } from "./recordPayment";

/**
 * 외부 환급 시도의 실패·불명확 결과 기록 (추가 전용, ST-Y07, BR-Y07).
 * 환급 원장이 아니다. UNKNOWN은 조회로 해소될 때까지 해당 금액을 환급 한도에서 예약한다.
 */
export type RefundAttempt = {
  id: string;
  tenantId: string;
  refundTaskId: string;
  orderId: string;
  paymentId: string;
  amountKrw: string;
  result: "FAILED" | "UNKNOWN";
  reason: string;
  reportedBy: string;
  reportedAt: string;
  recordedAt: string;
};

export type RefundAttemptRepository = {
  get(tenantId: string, id: string): RefundAttempt | undefined;
  list(tenantId: string, refundTaskId: string): RefundAttempt[];
  save(attempt: RefundAttempt): void;
};

export type ReportRefundAttemptDeps = {
  refundTasks: RefundTaskRepository;
  payments: PaymentRepository;
  refundAttempts: RefundAttemptRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ReportRefundAttemptRequest = {
  tenantId: string;
  refundTaskId: string;
  paymentId: string;
  amountKrw: string;
  result: "FAILED" | "UNKNOWN";
  reason: string;
  reportedBy: string;
  reportedAt: string;
  idempotencyKey: string;
};

export function reportRefundAttempt(
  deps: ReportRefundAttemptDeps,
  request: ReportRefundAttemptRequest,
): RefundAttempt {
  if (typeof request.amountKrw !== "string" || !/^[1-9]\d*$/.test(request.amountKrw)) {
    invalid("amountKrw", "must be a positive integer string in KRW");
  }
  if (request.result !== "FAILED" && request.result !== "UNKNOWN") {
    invalid("result", "must be FAILED or UNKNOWN");
  }
  for (const field of ["reason", "reportedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("reportedAt", request.reportedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.report-refund-attempt",
      key: request.idempotencyKey,
      payload: {
        refundTaskId: request.refundTaskId,
        paymentId: request.paymentId,
        amountKrw: request.amountKrw,
        result: request.result,
        reason: request.reason,
        reportedBy: request.reportedBy,
        reportedAt: request.reportedAt,
      },
    },
    () => {
      const task = deps.refundTasks.get(request.tenantId, request.refundTaskId);
      const payment = deps.payments.get(request.tenantId, request.paymentId);
      if (!task || !payment) {
        throw new AppError("NOT_FOUND");
      }
      const attempt: RefundAttempt = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        refundTaskId: task.id,
        orderId: task.orderId,
        paymentId: payment.id,
        amountKrw: request.amountKrw,
        result: request.result,
        reason: request.reason,
        reportedBy: request.reportedBy,
        reportedAt: request.reportedAt,
        recordedAt: now.toISOString(),
      };
      deps.refundAttempts.save(attempt);
      return attempt;
    },
  );
}
