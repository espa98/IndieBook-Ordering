import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { ReturnDispatchRepository } from "./dispatchReturn";
import type { ReturnExceptionRepository } from "./reportReturnException";
import type { ReturnRequestRepository } from "./requestReturn";

/** 반품 완료 기록 (추가 전용). 공급처의 최종 확인 근거를 남기며 비용 후속은 분리한다 (ST-C05). */
export type ReturnCompletion = {
  id: string;
  tenantId: string;
  returnRequestId: string;
  quantity: number;
  evidence: string;
  confirmedBy: string;
  confirmedAt: string;
  recordedAt: string;
};

export type ReturnCompletionRepository = {
  list(tenantId: string, returnRequestId: string): ReturnCompletion[];
  save(completion: ReturnCompletion): void;
};

export type CompleteReturnDeps = {
  returnRequests: ReturnRequestRepository;
  returnDispatches: Pick<ReturnDispatchRepository, "list">;
  returnCompletions: ReturnCompletionRepository;
  returnExceptions: Pick<ReturnExceptionRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CompleteReturnRequest = {
  tenantId: string;
  returnRequestId: string;
  quantity: number;
  evidence: string;
  confirmedBy: string;
  confirmedAt: string;
  idempotencyKey: string;
};

export function completeReturn(
  deps: CompleteReturnDeps,
  request: CompleteReturnRequest,
): ReturnCompletion {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
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
      operation: "inventory.complete-return",
      key: request.idempotencyKey,
      payload: {
        returnRequestId: request.returnRequestId,
        quantity: request.quantity,
        evidence: request.evidence,
        confirmedBy: request.confirmedBy,
        confirmedAt: request.confirmedAt,
      },
    },
    () => {
      const returnRequest = deps.returnRequests.get(request.tenantId, request.returnRequestId);
      if (!returnRequest) {
        throw new AppError("NOT_FOUND");
      }
      const dispatched = deps.returnDispatches
        .list(request.tenantId, returnRequest.id)
        .reduce((sum, d) => sum + d.quantity, 0);
      const completed = deps.returnCompletions
        .list(request.tenantId, returnRequest.id)
        .reduce((sum, c) => sum + c.quantity, 0);
      const excepted = deps.returnExceptions
        .list(request.tenantId, returnRequest.id)
        .reduce((sum, e) => sum + e.quantity, 0);
      // 실제로 출고한 수량만 완료할 수 있다. 요청이나 수락을 반품 완료로 간주하지 않는다 (BR-C02)
      if (request.quantity > dispatched - completed - excepted) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "completed quantity must not exceed the dispatched uncompleted quantity",
        );
      }
      const completion: ReturnCompletion = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        returnRequestId: returnRequest.id,
        quantity: request.quantity,
        evidence: request.evidence,
        confirmedBy: request.confirmedBy,
        confirmedAt: request.confirmedAt,
        recordedAt: now.toISOString(),
      };
      deps.returnCompletions.save(completion);
      return completion;
    },
  );
}
