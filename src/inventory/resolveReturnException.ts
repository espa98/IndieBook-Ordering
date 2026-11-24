import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { ReturnExceptionRepository } from "./reportReturnException";

export const RETURN_EXCEPTION_OUTCOMES = ["RECOVERED", "RETURNED"] as const;
export type ReturnExceptionOutcome = (typeof RETURN_EXCEPTION_OUTCOMES)[number];

/**
 * 반품 예외 해소 기록 (추가 전용). RECOVERED는 실물 회수·검수 후 처분 대기로 복귀,
 * RETURNED는 공급처 최종 확인으로 반품 완료에 귀속한다 (ST-C09).
 */
export type ReturnExceptionResolution = {
  id: string;
  tenantId: string;
  returnExceptionId: string;
  returnRequestId: string;
  outcome: ReturnExceptionOutcome;
  quantity: number;
  evidence: string;
  resolvedBy: string;
  resolvedAt: string;
  recordedAt: string;
};

export type ReturnExceptionResolutionRepository = {
  list(tenantId: string, returnExceptionId: string): ReturnExceptionResolution[];
  save(resolution: ReturnExceptionResolution): void;
};

export type ResolveReturnExceptionDeps = {
  returnExceptions: Pick<ReturnExceptionRepository, "get">;
  returnExceptionResolutions: ReturnExceptionResolutionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ResolveReturnExceptionRequest = {
  tenantId: string;
  returnExceptionId: string;
  outcome: ReturnExceptionOutcome;
  quantity: number;
  evidence: string;
  resolvedBy: string;
  resolvedAt: string;
  idempotencyKey: string;
};

export function resolveReturnException(
  deps: ResolveReturnExceptionDeps,
  request: ResolveReturnExceptionRequest,
): ReturnExceptionResolution {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!RETURN_EXCEPTION_OUTCOMES.includes(request.outcome)) {
    invalid("outcome", "must be RECOVERED or RETURNED");
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
      operation: "inventory.resolve-return-exception",
      key: request.idempotencyKey,
      payload: {
        returnExceptionId: request.returnExceptionId,
        outcome: request.outcome,
        quantity: request.quantity,
        evidence: request.evidence,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
      },
    },
    () => {
      const exception = deps.returnExceptions.get(request.tenantId, request.returnExceptionId);
      if (!exception) {
        throw new AppError("NOT_FOUND");
      }
      const resolved = deps.returnExceptionResolutions
        .list(request.tenantId, exception.id)
        .reduce((sum, r) => sum + r.quantity, 0);
      if (request.quantity > exception.quantity - resolved) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "resolved quantity must not exceed the unresolved exception quantity",
        );
      }
      const resolution: ReturnExceptionResolution = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        returnExceptionId: exception.id,
        returnRequestId: exception.returnRequestId,
        outcome: request.outcome,
        quantity: request.quantity,
        evidence: request.evidence,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
        recordedAt: now.toISOString(),
      };
      deps.returnExceptionResolutions.save(resolution);
      return resolution;
    },
  );
}
