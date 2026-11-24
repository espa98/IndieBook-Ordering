import type { GoodsReceipt } from "../../src/inventory/receiveGoods";
import type {
  DecideExcessReceiptRequest,
  ExcessDecision,
} from "../../src/inventory/decideExcessReceipt";
import { receiveGoods } from "../../src/inventory/receiveGoods";
import { sentScene } from "./procurementWorld";

export function createInMemoryReceiptRepository(initial: GoodsReceipt[] = []) {
  const all: GoodsReceipt[] = [...initial];
  return {
    list(tenantId: string, purchaseOrderId: string): GoodsReceipt[] {
      return all.filter(
        (r) => r.tenantId === tenantId && r.purchaseOrderId === purchaseOrderId,
      );
    },
    get(tenantId: string, id: string): GoodsReceipt | undefined {
      return all.find((r) => r.tenantId === tenantId && r.id === id);
    },
    save(receipt: GoodsReceipt): void {
      all.push(receipt);
    },
  };
}

export function createInMemoryExcessDecisionRepository() {
  const all: ExcessDecision[] = [];
  return {
    list(tenantId: string, receiptId: string): ExcessDecision[] {
      return all.filter((d) => d.tenantId === tenantId && d.receiptId === receiptId);
    },
    save(decision: ExcessDecision): void {
      all.push(decision);
    },
  };
}

/** 6권 발주에 8권이 입고되어 초과 2권이 승인 대기인 세계 */
export function excessScene() {
  const s = receivingScene();
  const receipt = receiveGoodsForScene(s);
  const excessDecisions = createInMemoryExcessDecisionRepository();
  const deps = { ...s.deps, excessDecisions };
  const request = (
    extra: Partial<DecideExcessReceiptRequest> = {},
  ): DecideExcessReceiptRequest => ({
    tenantId: "tenant-a",
    receiptId: receipt.id,
    decision: "APPROVED",
    quantity: 2,
    reason: "공급처 사과 증정분, 점주 승인",
    actorRole: "OWNER",
    decidedBy: "점주",
    decidedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: "exc-1",
    ...extra,
  });
  return { ...s, deps, receipt, excessDecisions, request };
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

function receiveGoodsForScene(s: ReturnType<typeof receivingScene>) {
  return receiveGoods(s.deps, s.request({ normalQuantity: 8, idempotencyKey: "recv-excess" }) as never);
}
