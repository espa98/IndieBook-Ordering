import type { ReceiptAllocationRepository } from "../inventory/allocateReceipt";
import type { AllocationCancellationRepository } from "../inventory/cancelAllocation";
import { cancellationOpenQuantity } from "../inventory/cancellationOpen";
import type { ReturnCompletionRepository } from "../inventory/completeReturn";
import type { ReturnExceptionRepository } from "../inventory/reportReturnException";
import type { ReturnExceptionResolutionRepository } from "../inventory/resolveReturnException";
import type { ReturnRequestRepository } from "../inventory/requestReturn";
import type { StockIntakeRepository } from "../inventory/transferCancelledToStock";
import type { ExcessDecisionRepository } from "../inventory/decideExcessReceipt";
import type { ReceiptCorrectionRepository } from "../inventory/correctReceipt";
import type { GoodsReceiptRepository } from "../inventory/receiveGoods";
import type { CancellationRepository } from "./createCancellationRequest";
import type { PurchaseOrder } from "./createPurchaseOrder";
import { cancellationRequestState } from "./cancellationRequestState";
import { poLineState } from "./poLineState";
import type { PoReplyRepository } from "./recordSupplierReply";

export type PurchaseOrderClosureBlocker = "OPEN_QUANTITY" | "EXCESS_UNDECIDED" | "DISPOSITION_OPEN" | "CANCELLATION_REQUEST_OPEN";

export type PurchaseOrderClosureEvaluation = {
  closable: boolean;
  blockers: PurchaseOrderClosureBlocker[];
};

export type EvaluatePurchaseOrderClosureDeps = {
  receipts: Pick<GoodsReceiptRepository, "list">;
  receiptAllocations: Pick<ReceiptAllocationRepository, "list">;
  allocationCancellations: Pick<AllocationCancellationRepository, "list">;
  stockIntakes: Pick<StockIntakeRepository, "list">;
  returnRequests: Pick<ReturnRequestRepository, "list">;
  returnCompletions: Pick<ReturnCompletionRepository, "list">;
  returnExceptions: Pick<ReturnExceptionRepository, "list">;
  returnExceptionResolutions: Pick<ReturnExceptionResolutionRepository, "list">;
  excessDecisions: Pick<ExcessDecisionRepository, "list">;
  receiptCorrections: Pick<ReceiptCorrectionRepository, "list">;
  replies: Pick<PoReplyRepository, "list">;
  cancellations: Pick<CancellationRepository, "listRequests" | "listResponses">;
};

/**
 * 발주 종결 가능 여부를 기록에서 계산한다 (ST-P11, BR-P06).
 * 정상 입고 순량과 공급처가 확정한 축소로 모든 품목의 잔량(Qopen)이 0이어야 한다.
 */
export function evaluatePurchaseOrderClosure(
  deps: EvaluatePurchaseOrderClosureDeps,
  tenantId: string,
  po: PurchaseOrder,
): PurchaseOrderClosureEvaluation {
  const blockers: PurchaseOrderClosureBlocker[] = [];
  const replies = deps.replies.list(tenantId, po.id);
  const responses = deps.cancellations.listResponses(tenantId, po.id);
  const receipts = deps.receipts.list(tenantId, po.id);
  const openQuantity = po.lines.some((line) => {
    const { qvalid } = poLineState(
      line.quantity,
      replies.filter((r) => r.poLineId === line.poLineId),
      responses
        .filter((r) => r.poLineId === line.poLineId)
        .reduce((sum, r) => sum + r.acceptedQuantity, 0),
    );
    const lineReceipts = receipts.filter((r) => r.poLineId === line.poLineId);
    const received =
      lineReceipts.reduce((sum, r) => sum + r.normalQuantity, 0) -
      lineReceipts
        .flatMap((r) => deps.receiptCorrections.list(tenantId, r.id))
        .reduce((sum, c) => sum + c.quantity, 0);
    return qvalid - received > 0;
  });
  if (openQuantity) blockers.push("OPEN_QUANTITY");
  // 초과입고는 승인·거절 결정으로 모두 처리되어야 한다 (BR-P06, D30)
  const excessUndecided = receipts.some(
    (r) =>
      r.excessQuantity -
        deps.excessDecisions.list(tenantId, r.id).reduce((sum, d) => sum + d.quantity, 0) >
      0,
  );
  if (excessUndecided) blockers.push("EXCESS_UNDECIDED");
  // 이 발주의 입고에서 주문 취소로 풀린 물량의 처분(편입·반품)이 끝나야 한다 (BR-P06, BR-O02)
  const dispositionOpen = receipts
    .flatMap((r) => deps.receiptAllocations.list(tenantId, r.id))
    .flatMap((a) => deps.allocationCancellations.list(tenantId, a.id))
    .some((c) => cancellationOpenQuantity(deps, tenantId, c) > 0);
  if (dispositionOpen) blockers.push("DISPOSITION_OPEN");
  // 공급처가 최종 응답하지 않은 취소 요청이 있으면 종결할 수 없다 (BR-P02)
  const requestOpen = deps.cancellations
    .listRequests(tenantId, po.id)
    .some(
      (r) =>
        cancellationRequestState(
          r.quantity,
          responses.filter((x) => x.requestId === r.id),
        ).unanswered > 0,
    );
  if (requestOpen) blockers.push("CANCELLATION_REQUEST_OPEN");
  return { closable: blockers.length === 0, blockers };
}
