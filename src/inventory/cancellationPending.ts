import type { AllocationCancellation } from "./cancelAllocation";
import type { ReturnExceptionRepository } from "./reportReturnException";
import type { ReturnExceptionResolutionRepository } from "./resolveReturnException";
import type { ReturnReplyRepository } from "./recordReturnReply";
import type { ReturnRequestRepository } from "./requestReturn";
import type { StockIntakeRepository } from "./transferCancelledToStock";

/**
 * 취소 처분 단위의 처분 대기 잔량 = 취소 수량 - 재고 편입 - (반품 요청 - 공급처 거절 - 회수 확인).
 * 반품 요청 중이거나 수락된 수량은 처분 대기가 아니고, 거절된 수량은 다시 처분 대기다 (BR-Q15, ST-C06).
 */
export function cancellationPending(
  deps: {
    stockIntakes: Pick<StockIntakeRepository, "list">;
    returnRequests: Pick<ReturnRequestRepository, "list">;
    returnReplies: Pick<ReturnReplyRepository, "list">;
    returnExceptions: Pick<ReturnExceptionRepository, "list">;
    returnExceptionResolutions: Pick<ReturnExceptionResolutionRepository, "list">;
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
      // 실물 회수·검수가 확인된 예외 수량은 다시 처분 대기다 (ST-C09 RECOVERED, D31)
      const recovered = deps.returnExceptions
        .list(tenantId, request.id)
        .flatMap((e) => deps.returnExceptionResolutions.list(tenantId, e.id))
        .filter((r) => r.outcome === "RECOVERED")
        .reduce((total, r) => total + r.quantity, 0);
      return sum + request.quantity - rejected - recovered;
    }, 0);
  return cancellation.quantity - intaken - heldForReturn;
}
