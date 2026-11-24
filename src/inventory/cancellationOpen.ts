import type { AllocationCancellation } from "./cancelAllocation";
import type { ReturnCompletionRepository } from "./completeReturn";
import type { ReturnExceptionRepository } from "./reportReturnException";
import type { ReturnExceptionResolutionRepository } from "./resolveReturnException";
import type { ReturnRequestRepository } from "./requestReturn";
import type { StockIntakeRepository } from "./transferCancelledToStock";

/**
 * 취소 처분 단위가 아직 최종 귀속되지 않은 수량 = 취소 수량 - 재고 편입 - 반품 완료(공급처 최종 확인 포함).
 * 처분 대기, 반품 요청·출고 중, 반송·분실 예외가 모두 여기에 남는다 (BR-Q15, BR-O02).
 */
export function cancellationOpenQuantity(
  deps: {
    stockIntakes: Pick<StockIntakeRepository, "list">;
    returnRequests: Pick<ReturnRequestRepository, "list">;
    returnCompletions: Pick<ReturnCompletionRepository, "list">;
    returnExceptions: Pick<ReturnExceptionRepository, "list">;
    returnExceptionResolutions: Pick<ReturnExceptionResolutionRepository, "list">;
  },
  tenantId: string,
  cancellation: AllocationCancellation,
): number {
  const sum = (items: readonly { quantity: number }[]) =>
    items.reduce((total, i) => total + i.quantity, 0);
  const intaken = sum(deps.stockIntakes.list(tenantId, cancellation.id));
  const returned = deps.returnRequests.list(tenantId, cancellation.id).reduce((total, request) => {
    const completed = sum(deps.returnCompletions.list(tenantId, request.id));
    const finalFromExceptions = deps.returnExceptions
      .list(tenantId, request.id)
      .flatMap((e) => deps.returnExceptionResolutions.list(tenantId, e.id))
      .filter((r) => r.outcome === "RETURNED")
      .reduce((t, r) => t + r.quantity, 0);
    return total + completed + finalFromExceptions;
  }, 0);
  return cancellation.quantity - intaken - returned;
}
