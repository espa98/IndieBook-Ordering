import type { ReceiptCorrectionRepository } from "../inventory/correctReceipt";
import type { GoodsReceipt } from "../inventory/receiveGoods";
import type { CancellationResponse } from "./createCancellationRequest";
import type { PoLine } from "./createPurchaseOrder";
import { poLineState } from "./poLineState";
import type { PoReply } from "./recordSupplierReply";

/**
 * 발주 품목의 미입고 잔량 Qopen = 유효 발주량 − 정상 입고 순량 (BR-P01, BR-Q12).
 * 입력은 해당 발주의 모든 회신·취소 응답·입고이며, 품목별 필터링은 여기서 한다.
 */
export function poLineOpenQuantity(
  deps: { receiptCorrections: Pick<ReceiptCorrectionRepository, "list"> },
  tenantId: string,
  line: PoLine,
  replies: readonly PoReply[],
  responses: readonly CancellationResponse[],
  receipts: readonly GoodsReceipt[],
): number {
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
  return qvalid - received;
}
