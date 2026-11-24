import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { NotificationAttemptRepository } from "./recordNotificationAttempt";

export type NotificationOutcome = "MANUAL_RECORDED" | "FAILED";

/**
 * 직원이 확인한 안내 결과 (추가 전용, ST-M04). 고객의 수신·읽음은 추정하거나 저장하지 않는다 (MSG-010).
 * FAILED이면 재안내(ST-M05)의 근거가 된다.
 */
export type NotificationResult = {
  id: string;
  tenantId: string;
  targetId: string;
  attemptId: string;
  outcome: NotificationOutcome;
  note: string;
  recordedBy: string;
  resultAt: string;
  recordedAt: string;
};

export type NotificationResultRepository = {
  list(tenantId: string, targetId: string): NotificationResult[];
  save(result: NotificationResult): void;
};

export type RecordNotificationResultDeps = {
  notificationAttempts: NotificationAttemptRepository;
  notificationResults: NotificationResultRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RecordNotificationResultRequest = {
  tenantId: string;
  attemptId: string;
  outcome: NotificationOutcome;
  note: string;
  recordedBy: string;
  resultAt: string;
  idempotencyKey: string;
};

export function recordNotificationResult(
  deps: RecordNotificationResultDeps,
  request: RecordNotificationResultRequest,
): NotificationResult {
  if (request.outcome !== "MANUAL_RECORDED" && request.outcome !== "FAILED") {
    invalid("outcome", "must be MANUAL_RECORDED or FAILED");
  }
  for (const field of ["note", "recordedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("resultAt", request.resultAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "notification.record-result",
      key: request.idempotencyKey,
      payload: {
        attemptId: request.attemptId,
        outcome: request.outcome,
        note: request.note,
        recordedBy: request.recordedBy,
        resultAt: request.resultAt,
      },
    },
    () => {
      const attempt = deps.notificationAttempts.get(request.tenantId, request.attemptId);
      if (!attempt) {
        throw new AppError("NOT_FOUND");
      }
      // 시도 하나에 결과는 한 번만 기록한다. 결과를 바꿔야 하면 재안내(ST-M05)로 새 대상을 만든다
      if (
        deps.notificationResults
          .list(request.tenantId, attempt.targetId)
          .some((r) => r.attemptId === attempt.id)
      ) {
        throw new AppError("BUSINESS_INVARIANT", "a result is already recorded for this attempt");
      }
      const result: NotificationResult = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        targetId: attempt.targetId,
        attemptId: attempt.id,
        outcome: request.outcome,
        note: request.note,
        recordedBy: request.recordedBy,
        resultAt: request.resultAt,
        recordedAt: now.toISOString(),
      };
      deps.notificationResults.save(result);
      return result;
    },
  );
}
