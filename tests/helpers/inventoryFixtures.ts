import type { GoodsReceipt } from "../../src/inventory/receiveGoods";
import type {
  DecideExcessReceiptRequest,
  ExcessDecision,
} from "../../src/inventory/decideExcessReceipt";
import type {
  AllocateReceiptRequest,
  ReceiptAllocation,
} from "../../src/inventory/allocateReceipt";
import type {
  AllocationRelease,
  ReleaseAllocationRequest,
} from "../../src/inventory/releaseAllocation";
import { allocateReceipt } from "../../src/inventory/allocateReceipt";
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

export function createInMemoryReceiptAllocationRepository() {
  const all: ReceiptAllocation[] = [];
  return {
    list(tenantId: string, receiptId: string): ReceiptAllocation[] {
      return all.filter((a) => a.tenantId === tenantId && a.receiptId === receiptId);
    },
    get(tenantId: string, id: string): ReceiptAllocation | undefined {
      return all.find((a) => a.tenantId === tenantId && a.id === id);
    },
    save(allocation: ReceiptAllocation): void {
      all.push(allocation);
    },
  };
}

export function createInMemoryAllocationReleaseRepository() {
  const all: AllocationRelease[] = [];
  return {
    list(tenantId: string, allocationId: string): AllocationRelease[] {
      return all.filter((r) => r.tenantId === tenantId && r.allocationId === allocationId);
    },
    save(release: AllocationRelease): void {
      all.push(release);
    },
  };
}

/** 4권 입고 중 주문 B(연결 3권)에 3권이 배분되어 OPEN인 세계 */
export function releaseScene() {
  const s = allocationScene();
  const allocation = allocateReceipt(
    s.deps,
    s.request({
      orderId: s.orders[1]!.id,
      orderLineId: s.orders[1]!.lines[0]!.lineId,
      quantity: 3,
    }),
  );
  const { allocationReleases } = s.deps;
  const deps = s.deps;
  let seq = 0;
  const request = (
    extra: Partial<ReleaseAllocationRequest> = {},
  ): ReleaseAllocationRequest => ({
    tenantId: "tenant-a",
    allocationId: allocation.id,
    quantity: 1,
    reason: "고객이 다른 도서로 변경 요청",
    releasedBy: "김직원",
    releasedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `rel-${++seq}`,
    ...extra,
  });
  return {
    ...s,
    deps,
    allocation,
    allocationReleases,
    /** 해제 요청 */
    request,
    /** 추가 배분 요청 */
    allocateRequest: s.request,
  };
}

/** 6권 발주(주문 2/3/1권)에 4권이 정상 입고되어 미배분 4권인 세계 */
export function allocationScene() {
  const s = receivingScene();
  const receipt = receiveGoods(s.deps, s.request() as never);
  const receiptAllocations = createInMemoryReceiptAllocationRepository();
  const allocationReleases = createInMemoryAllocationReleaseRepository();
  const deps = { ...s.deps, orders: s.w.deps.orders, receiptAllocations, allocationReleases };
  let seq = 0; // 호출마다 다른 작업이므로 기본 멱등 키는 고유해야 한다
  const request = (
    extra: Partial<AllocateReceiptRequest> = {},
  ): AllocateReceiptRequest => ({
    tenantId: "tenant-a",
    receiptId: receipt.id,
    orderId: s.orders[0]!.id,
    orderLineId: s.orders[0]!.lines[0]!.lineId,
    quantity: 2,
    allocatedBy: "김직원",
    allocatedAt: "2026-03-04T06:40:00.000Z",
    idempotencyKey: `alloc-${++seq}`,
    ...extra,
  });
  return { ...s, deps, receipt, receiptAllocations, request };
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
