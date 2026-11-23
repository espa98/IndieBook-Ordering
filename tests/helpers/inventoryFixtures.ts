import type { GoodsReceipt } from "../../src/inventory/receiveGoods";
import { sentScene } from "./procurementWorld";

export function createInMemoryReceiptRepository(initial: GoodsReceipt[] = []) {
  const all: GoodsReceipt[] = [...initial];
  return {
    list(tenantId: string, purchaseOrderId: string): GoodsReceipt[] {
      return all.filter(
        (r) => r.tenantId === tenantId && r.purchaseOrderId === purchaseOrderId,
      );
    },
    save(receipt: GoodsReceipt): void {
      all.push(receipt);
    },
  };
}

/** 전달 완료(SENT) 발주 1개(book-1 6권)와 입고 저장소가 있는 세계 */
export function receivingScene(options: Parameters<typeof sentScene>[0] = {}) {
  const s = sentScene(options);
  const receipts = createInMemoryReceiptRepository();
  const deps = { ...s.deps, receipts };
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: s.sent.id,
    poLineId: s.poLineId,
    normalQuantity: 4,
    damagedQuantity: 0,
    misdeliveredQuantity: 0,
    inspectedBy: "김검수",
    receivedAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: "recv-1",
    ...extra,
  });
  return { ...s, deps, receipts, request };
}
