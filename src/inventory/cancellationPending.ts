import type { AllocationCancellation } from "./cancelAllocation";
import type { ReturnReplyRepository } from "./recordReturnReply";
import type { ReturnRequestRepository } from "./requestReturn";
import type { StockIntakeRepository } from "./transferCancelledToStock";

/**
 * 취소 처분 단위의 처분 대기 잔량 = 취소 수량 - 재고 편입 - (반품 요청 - 공급처 거절).
 * 반품 요청 중이거나 수락된 수량은 처분 대기가 아니고, 거절된 수량은 다시 처분 대기다 (BR-Q15, ST-C06).
 */
export function cancellationPending(
  deps: {
    stockIntakes: Pick<StockIntakeRepository, "list">;
    returnRequests: Pick<ReturnRequestRepository, "list">;
    returnReplies: Pick<ReturnReplyRepository, "list">;
  },
  tenantId: string,
  cancellation: AllocationCancellation,
): number {
  const intaken = deps.stockIntakes
    .list(tenantId, cancellation.id)
    .reduce((sum, i) => sum + i.quantity, 0);
  const heldForReturn = deps.returnRequests
    .list(tenantId, cancellation.id)
    .reduce((sum, request) => {
      const rejected = deps.returnReplies
        .list(tenantId, request.id)
        .reduce((total, reply) => total + reply.rejectedQuantity, 0);
      return sum + request.quantity - rejected;
    }, 0);
  return cancellation.quantity - intaken - heldForReturn;
}
