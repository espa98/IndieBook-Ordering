import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { ReturnReplyRepository } from "./recordReturnReply";
import type { ReturnRequestRepository } from "./requestReturn";

/** 반품 출고 기록 (추가 전용). 실제 출고 수량과 참조를 남긴다 (ST-C04). */
export type ReturnDispatch = {
  id: string;
  tenantId: string;
  returnRequestId: string;
  quantity: number;
  dispatchedBy: string;
  dispatchedAt: string;
  referenceNumber?: string;
  recordedAt: string;
};

export type ReturnDispatchRepository = {
  list(tenantId: string, returnRequestId: string): ReturnDispatch[];
  save(dispatch: ReturnDispatch): void;
};

export type DispatchReturnDeps = {
  returnRequests: ReturnRequestRepository;
  returnReplies: Pick<ReturnReplyRepository, "list">;
  returnDispatches: ReturnDispatchRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type DispatchReturnRequest = {
  tenantId: string;
  returnRequestId: string;
  quantity: number;
  dispatchedBy: string;
  dispatchedAt: string;
  referenceNumber?: string;
  idempotencyKey: string;
};

export function dispatchReturn(
  deps: DispatchReturnDeps,
  request: DispatchReturnRequest,
): ReturnDispatch {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!isNonEmptyString(request.dispatchedBy)) {
    invalid("dispatchedBy", "must be a non-empty string");
  }
  if (request.referenceNumber !== undefined && !isNonEmptyString(request.referenceNumber)) {
    invalid("referenceNumber", "must be a non-empty string when given");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("dispatchedAt", request.dispatchedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.dispatch-return",
      key: request.idempotencyKey,
      payload: {
        returnRequestId: request.returnRequestId,
        quantity: request.quantity,
        dispatchedBy: request.dispatchedBy,
        dispatchedAt: request.dispatchedAt,
        referenceNumber: request.referenceNumber ?? null,
      },
    },
    () => {
      const returnRequest = deps.returnRequests.get(request.tenantId, request.returnRequestId);
      if (!returnRequest) {
        throw new AppError("NOT_FOUND");
      }
      const accepted = deps.returnReplies
        .list(request.tenantId, returnRequest.id)
        .reduce((sum, r) => sum + r.acceptedQuantity, 0);
      const dispatched = deps.returnDispatches
        .list(request.tenantId, returnRequest.id)
        .reduce((sum, d) => sum + d.quantity, 0);
      // 공급처가 수락한 미출고 수량만 출고할 수 있다 (ST-C04)
      if (request.quantity > accepted - dispatched) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "dispatched quantity must not exceed the accepted undispatched quantity",
        );
      }
      const dispatch: ReturnDispatch = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        returnRequestId: returnRequest.id,
        quantity: request.quantity,
        dispatchedBy: request.dispatchedBy,
        dispatchedAt: request.dispatchedAt,
        ...(request.referenceNumber === undefined
          ? {}
          : { referenceNumber: request.referenceNumber }),
        recordedAt: now.toISOString(),
      };
      deps.returnDispatches.save(dispatch);
      return dispatch;
    },
  );
}
