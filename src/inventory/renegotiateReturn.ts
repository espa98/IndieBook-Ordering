import type { PurchaseOrderRepository } from "../procurement/createPurchaseOrder";
import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { AllocationCancellationRepository } from "./cancelAllocation";
import { cancellationPending } from "./cancellationPending";
import type { GoodsReceiptRepository } from "./receiveGoods";
import type { ReturnExceptionRepository } from "./reportReturnException";
import type { ReturnExceptionResolutionRepository } from "./resolveReturnException";
import type { ReturnReplyRepository } from "./recordReturnReply";
import type { ReturnRequest, ReturnRequestRepository } from "./requestReturn";
import type { StockIntakeRepository } from "./transferCancelledToStock";

export type RenegotiateReturnDeps = {
  allocationCancellations: Pick<AllocationCancellationRepository, "get">;
  receipts: GoodsReceiptRepository;
  purchaseOrders: PurchaseOrderRepository;
  returnRequests: ReturnRequestRepository;
  returnReplies: Pick<ReturnReplyRepository, "list">;
  returnExceptions: Pick<ReturnExceptionRepository, "list">;
  returnExceptionResolutions: Pick<ReturnExceptionResolutionRepository, "list">;
  stockIntakes: Pick<StockIntakeRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RenegotiateReturnRequest = {
  tenantId: string;
  originalRequestId: string;
  quantity: number;
  retryReason: string;
  requestedBy: string;
  requestedAt: string;
  idempotencyKey: string;
};

/** 거절된 반품 수량을 원 요청을 보존한 채 다시 요청한다 (ST-C07). */
export function renegotiateReturn(
  deps: RenegotiateReturnDeps,
  request: RenegotiateReturnRequest,
): ReturnRequest {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["retryReason", "requestedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("requestedAt", request.requestedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.renegotiate-return",
      key: request.idempotencyKey,
      payload: {
        originalRequestId: request.originalRequestId,
        quantity: request.quantity,
        retryReason: request.retryReason,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
      },
    },
    () => {
      const original = deps.returnRequests.get(request.tenantId, request.originalRequestId);
      if (!original) {
        throw new AppError("NOT_FOUND");
      }
      const cancellation = deps.allocationCancellations.get(request.tenantId, original.cancellationId)!;
      const receipt = deps.receipts.get(request.tenantId, cancellation.receiptId)!;
      const po = deps.purchaseOrders.get(request.tenantId, receipt.purchaseOrderId)!;
      const rejected = deps.returnReplies
        .list(request.tenantId, original.id)
        .reduce((sum, r) => sum + r.rejectedQuantity, 0);
      const alreadyRetried = deps.returnRequests
        .list(request.tenantId, cancellation.id)
        .filter((r) => r.retryOfRequestId === original.id)
        .reduce((sum, r) => sum + r.quantity, 0);
      // 재협의는 원 요청에서 거절된 수량 중 아직 재협의하지 않았고 처분 대기로 남아 있는 수량만 가능하다
      const pending = cancellationPending(deps, request.tenantId, cancellation);
      if (request.quantity > Math.min(rejected - alreadyRetried, pending)) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "renegotiated quantity must not exceed the rejected, still pending quantity",
        );
      }
      const retry: ReturnRequest = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: cancellation.bookId,
        cancellationId: cancellation.id,
        receiptId: receipt.id,
        supplierCode: po.supplierCode,
        quantity: request.quantity,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        retryOfRequestId: original.id,
        retryReason: request.retryReason,
        recordedAt: now.toISOString(),
      };
      deps.returnRequests.save(retry);
      return retry;
    },
  );
}
