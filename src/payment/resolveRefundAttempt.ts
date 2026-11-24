import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { RefundAttemptRepository } from "./reportRefundAttempt";

/**
 * UNKNOWN 환급 시도의 해소 기록 (추가 전용, ST-Y07). 사업자·은행 조회 결과로만 FAILED/CONFIRMED가 된다 (BR-Y12).
 * CONFIRMED여도 환급 원장은 기록하지 않는다. 원장은 환급 요청·Owner 승인 경로에서만 생긴다 (DEC-09).
 */
export type RefundAttemptResolution = {
  id: string;
  tenantId: string;
  attemptId: string;
  refundTaskId: string;
  outcome: "FAILED" | "CONFIRMED";
  evidence: string;
  resolvedBy: string;
  resolvedAt: string;
  recordedAt: string;
};

export type RefundAttemptResolutionRepository = {
  list(tenantId: string, attemptId: string): RefundAttemptResolution[];
  save(resolution: RefundAttemptResolution): void;
};

export type ResolveRefundAttemptDeps = {
  refundAttempts: Pick<RefundAttemptRepository, "get">;
  refundAttemptResolutions: RefundAttemptResolutionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ResolveRefundAttemptRequest = {
  tenantId: string;
  attemptId: string;
  outcome: "FAILED" | "CONFIRMED";
  evidence: string;
  resolvedBy: string;
  resolvedAt: string;
  idempotencyKey: string;
};

export function resolveRefundAttempt(
  deps: ResolveRefundAttemptDeps,
  request: ResolveRefundAttemptRequest,
): RefundAttemptResolution {
  if (request.outcome !== "FAILED" && request.outcome !== "CONFIRMED") {
    invalid("outcome", "must be FAILED or CONFIRMED");
  }
  for (const field of ["evidence", "resolvedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("resolvedAt", request.resolvedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.resolve-refund-attempt",
      key: request.idempotencyKey,
      payload: {
        attemptId: request.attemptId,
        outcome: request.outcome,
        evidence: request.evidence,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
      },
    },
    () => {
      const attempt = deps.refundAttempts.get(request.tenantId, request.attemptId);
      if (!attempt) {
        throw new AppError("NOT_FOUND");
      }
      // 조회로 해소할 수 있는 것은 아직 해소되지 않은 UNKNOWN 시도뿐이다
      if (
        attempt.result !== "UNKNOWN" ||
        deps.refundAttemptResolutions.list(request.tenantId, attempt.id).length > 0
      ) {
        throw new AppError("BUSINESS_INVARIANT", "only an unresolved UNKNOWN attempt can be resolved");
      }
      const resolution: RefundAttemptResolution = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        attemptId: attempt.id,
        refundTaskId: attempt.refundTaskId,
        outcome: request.outcome,
        evidence: request.evidence,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
        recordedAt: now.toISOString(),
      };
      deps.refundAttemptResolutions.save(resolution);
      return resolution;
    },
  );
}
