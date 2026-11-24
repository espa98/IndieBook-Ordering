import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { ReturnCompletionRepository } from "./completeReturn";
import type { ReturnDispatchRepository } from "./dispatchReturn";
import type { ReturnRequestRepository } from "./requestReturn";

export const RETURN_EXCEPTION_KINDS = ["RETURNED_BACK", "LOST", "REFUSED"] as const;
export type ReturnExceptionKind = (typeof RETURN_EXCEPTION_KINDS)[number];

/** 반품 출고 후 반송·분실·거절 예외 (추가 전용). 신고된 수량은 정상 완료 흐름에서 빠진다 (ST-C08). */
export type ReturnException = {
  id: string;
  tenantId: string;
  returnRequestId: string;
  quantity: number;
  kind: ReturnExceptionKind;
  evidence: string;
  reportedBy: string;
  reportedAt: string;
  recordedAt: string;
};

export type ReturnExceptionRepository = {
  get(tenantId: string, id: string): ReturnException | undefined;
  list(tenantId: string, returnRequestId: string): ReturnException[];
  save(exception: ReturnException): void;
};

export type ReportReturnExceptionDeps = {
  returnRequests: ReturnRequestRepository;
  returnDispatches: Pick<ReturnDispatchRepository, "list">;
  returnCompletions: Pick<ReturnCompletionRepository, "list">;
  returnExceptions: ReturnExceptionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ReportReturnExceptionRequest = {
  tenantId: string;
  returnRequestId: string;
  quantity: number;
  kind: ReturnExceptionKind;
  evidence: string;
  reportedBy: string;
  reportedAt: string;
  idempotencyKey: string;
};

export function reportReturnException(
  deps: ReportReturnExceptionDeps,
  request: ReportReturnExceptionRequest,
): ReturnException {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!RETURN_EXCEPTION_KINDS.includes(request.kind)) {
    invalid("kind", "must be RETURNED_BACK, LOST or REFUSED");
  }
  for (const field of ["evidence", "reportedBy"] as const) {
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
      operation: "inventory.report-return-exception",
      key: request.idempotencyKey,
      payload: {
        returnRequestId: request.returnRequestId,
        quantity: request.quantity,
        kind: request.kind,
        evidence: request.evidence,
        reportedBy: request.reportedBy,
        reportedAt: request.reportedAt,
      },
    },
    () => {
      const returnRequest = deps.returnRequests.get(request.tenantId, request.returnRequestId);
      if (!returnRequest) {
        throw new AppError("NOT_FOUND");
      }
      const sum = (items: { quantity: number }[]) =>
        items.reduce((total, i) => total + i.quantity, 0);
      const inTransit =
        sum(deps.returnDispatches.list(request.tenantId, returnRequest.id)) -
        sum(deps.returnCompletions.list(request.tenantId, returnRequest.id)) -
        sum(deps.returnExceptions.list(request.tenantId, returnRequest.id));
      // 출고했지만 완료·기신고되지 않은 수량만 예외로 신고할 수 있다 (ST-C08)
      if (request.quantity > inTransit) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "reported quantity must not exceed the dispatched in-transit quantity",
        );
      }
      const exception: ReturnException = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        returnRequestId: returnRequest.id,
        quantity: request.quantity,
        kind: request.kind,
        evidence: request.evidence,
        reportedBy: request.reportedBy,
        reportedAt: request.reportedAt,
        recordedAt: now.toISOString(),
      };
      deps.returnExceptions.save(exception);
      return exception;
    },
  );
}
