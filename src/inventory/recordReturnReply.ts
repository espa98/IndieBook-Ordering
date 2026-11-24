import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { ReturnRequestRepository } from "./requestReturn";

/** 공급처 반품 회신 (추가 전용). 수락·거절 수량과 근거를 기록하고 미응답 수량은 남긴다 (ST-C03). */
export type ReturnReply = {
  id: string;
  tenantId: string;
  returnRequestId: string;
  acceptedQuantity: number;
  rejectedQuantity: number;
  evidence: string;
  repliedBy: string;
  repliedAt: string;
  recordedAt: string;
};

export type ReturnReplyRepository = {
  list(tenantId: string, returnRequestId: string): ReturnReply[];
  save(reply: ReturnReply): void;
};

export type RecordReturnReplyDeps = {
  returnRequests: ReturnRequestRepository;
  returnReplies: ReturnReplyRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RecordReturnReplyRequest = {
  tenantId: string;
  returnRequestId: string;
  acceptedQuantity: number;
  rejectedQuantity: number;
  evidence: string;
  repliedBy: string;
  repliedAt: string;
  idempotencyKey: string;
};

export function recordReturnReply(
  deps: RecordReturnReplyDeps,
  request: RecordReturnReplyRequest,
): ReturnReply {
  for (const field of ["acceptedQuantity", "rejectedQuantity"] as const) {
    if (!Number.isInteger(request[field]) || request[field] < 0) {
      invalid(field, "must be an integer >= 0");
    }
  }
  if (request.acceptedQuantity + request.rejectedQuantity < 1) {
    invalid("quantity", "at least one replied quantity must be positive");
  }
  for (const field of ["evidence", "repliedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("repliedAt", request.repliedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.record-return-reply",
      key: request.idempotencyKey,
      payload: {
        returnRequestId: request.returnRequestId,
        acceptedQuantity: request.acceptedQuantity,
        rejectedQuantity: request.rejectedQuantity,
        evidence: request.evidence,
        repliedBy: request.repliedBy,
        repliedAt: request.repliedAt,
      },
    },
    () => {
      const returnRequest = deps.returnRequests.get(request.tenantId, request.returnRequestId);
      if (!returnRequest) {
        throw new AppError("NOT_FOUND");
      }
      const replied = deps.returnReplies
        .list(request.tenantId, returnRequest.id)
        .reduce((sum, r) => sum + r.acceptedQuantity + r.rejectedQuantity, 0);
      // 미응답 수량만 회신할 수 있다 (BR-C01)
      if (request.acceptedQuantity + request.rejectedQuantity > returnRequest.quantity - replied) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "replied quantity must not exceed the return request's unanswered quantity",
        );
      }
      const reply: ReturnReply = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        returnRequestId: returnRequest.id,
        acceptedQuantity: request.acceptedQuantity,
        rejectedQuantity: request.rejectedQuantity,
        evidence: request.evidence,
        repliedBy: request.repliedBy,
        repliedAt: request.repliedAt,
        recordedAt: now.toISOString(),
      };
      deps.returnReplies.save(reply);
      return reply;
    },
  );
}
