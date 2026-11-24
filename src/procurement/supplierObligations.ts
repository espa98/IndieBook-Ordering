import type { ReceiptCorrectionRepository } from "../inventory/correctReceipt";
import type { GoodsReceiptRepository } from "../inventory/receiveGoods";
import type { CancellationRepository } from "./createCancellationRequest";
import type { PurchaseOrderRepository } from "./createPurchaseOrder";
import { poLineOpenQuantity } from "./poLineOpenQuantity";
import type { PoReplyRepository } from "./recordSupplierReply";
import type { SourcingRelease } from "./releaseSourcing";

/** 고객 주문에서 배정을 풀었지만 공급처에는 아직 남아 있는 구매 의무 (BR-P05). 저장하지 않고 기록에서 파생한다. */
export type OpenSupplierObligation = {
  purchaseOrderId: string;
  poLineId: string;
  supplierCode: string;
  /** 배정 해제 때 남기로 한 수량의 합 */
  retainedQuantity: number;
  /** 지금도 발주 품목의 미입고 잔량 안에 있는 수량 = min(유지 수량, Qopen) */
  openQuantity: number;
};

export type SupplierObligationDeps = {
  purchaseOrders: Pick<PurchaseOrderRepository, "get">;
  replies: Pick<PoReplyRepository, "list">;
  cancellations: Pick<CancellationRepository, "listResponses">;
  receipts: Pick<GoodsReceiptRepository, "list">;
  receiptCorrections: Pick<ReceiptCorrectionRepository, "list">;
  sourcingReleases: { listByOrder(tenantId: string, orderId: string): SourcingRelease[] };
};

/**
 * 주문이 풀어낸 배정 중 공급처 의무가 남은 것을 계산한다. 공급처가 축소를 수락하거나
 * 물량이 입고되어 발주 품목의 잔량이 줄면 의무도 같이 줄어든다.
 */
export function openSupplierObligations(
  deps: SupplierObligationDeps,
  tenantId: string,
  orderId: string,
  /** 주문 품목으로 좁힌다. 생략하면 주문 전체다 */
  lineId?: string,
): OpenSupplierObligation[] {
  const retained = new Map<string, { purchaseOrderId: string; poLineId: string; quantity: number }>();
  for (const release of deps.sourcingReleases.listByOrder(tenantId, orderId)) {
    if (lineId !== undefined && release.lineId !== lineId) continue;
    for (const o of release.retainedObligations) {
      const key = `${o.purchaseOrderId}:${o.poLineId}`;
      const entry = retained.get(key) ?? { purchaseOrderId: o.purchaseOrderId, poLineId: o.poLineId, quantity: 0 };
      entry.quantity += o.quantity;
      retained.set(key, entry);
    }
  }
  const result: OpenSupplierObligation[] = [];
  for (const { purchaseOrderId, poLineId, quantity } of retained.values()) {
    const po = deps.purchaseOrders.get(tenantId, purchaseOrderId);
    const line = po?.lines.find((l) => l.poLineId === poLineId);
    if (!po || !line) continue;
    const open = poLineOpenQuantity(
      deps,
      tenantId,
      line,
      deps.replies.list(tenantId, po.id),
      deps.cancellations.listResponses(tenantId, po.id),
      deps.receipts.list(tenantId, po.id),
    );
    const openQuantity = Math.min(quantity, Math.max(0, open));
    if (openQuantity > 0) {
      result.push({
        purchaseOrderId,
        poLineId,
        supplierCode: po.supplierCode,
        retainedQuantity: quantity,
        openQuantity,
      });
    }
  }
  return result;
}
