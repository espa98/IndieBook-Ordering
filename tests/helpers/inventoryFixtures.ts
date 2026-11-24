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
import type {
  AllocationDelivery,
  DeliverAllocationRequest,
} from "../../src/inventory/deliverAllocation";
import type {
  CorrectReceiptRequest,
  ReceiptCorrection,
} from "../../src/inventory/correctReceipt";
import type {
  AllocationCancellation,
  CancelAllocationRequest,
} from "../../src/inventory/cancelAllocation";
import type { RenegotiateReturnRequest } from "../../src/inventory/renegotiateReturn";
import type {
  ResolveReturnExceptionRequest,
  ReturnExceptionResolution,
} from "../../src/inventory/resolveReturnException";
import type {
  ReportReturnExceptionRequest,
  ReturnException,
} from "../../src/inventory/reportReturnException";
import type {
  CompleteReturnRequest,
  ReturnCompletion,
} from "../../src/inventory/completeReturn";
import type {
  DispatchReturnRequest,
  ReturnDispatch,
} from "../../src/inventory/dispatchReturn";
import type {
  RecordReturnReplyRequest,
  ReturnReply,
} from "../../src/inventory/recordReturnReply";
import type {
  RequestReturnRequest,
  ReturnRequest,
} from "../../src/inventory/requestReturn";
import type {
  StockIntake,
  TransferCancelledToStockRequest,
} from "../../src/inventory/transferCancelledToStock";
import { reportReturnException } from "../../src/inventory/reportReturnException";
import { dispatchReturn } from "../../src/inventory/dispatchReturn";
import { recordReturnReply } from "../../src/inventory/recordReturnReply";
import { requestReturn } from "../../src/inventory/requestReturn";
import { registerInitialStock } from "../../src/inventory/registerInitialStock";
import { cancelAllocation } from "../../src/inventory/cancelAllocation";
import type { ReallocateAllocationRequest } from "../../src/inventory/reallocateAllocation";
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
    listByOrder(tenantId: string, orderId: string): ReceiptAllocation[] {
      return all.filter((a) => a.tenantId === tenantId && a.orderId === orderId);
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

export function createInMemoryAllocationDeliveryRepository() {
  const all: AllocationDelivery[] = [];
  return {
    list(tenantId: string, allocationId: string): AllocationDelivery[] {
      return all.filter((d) => d.tenantId === tenantId && d.allocationId === allocationId);
    },
    save(delivery: AllocationDelivery): void {
      all.push(delivery);
    },
  };
}

export function createInMemoryAllocationCancellationRepository() {
  const all: AllocationCancellation[] = [];
  return {
    get(tenantId: string, id: string): AllocationCancellation | undefined {
      return all.find((c) => c.tenantId === tenantId && c.id === id);
    },
    list(tenantId: string, allocationId: string): AllocationCancellation[] {
      return all.filter((c) => c.tenantId === tenantId && c.allocationId === allocationId);
    },
    save(cancellation: AllocationCancellation): void {
      all.push(cancellation);
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
  const allocationDeliveries = createInMemoryAllocationDeliveryRepository();
  const deps = {
    ...s.deps,
    orders: s.w.deps.orders,
    receiptAllocations,
    allocationReleases,
    allocationDeliveries,
    allocationCancellations: createInMemoryAllocationCancellationRepository(),
  };
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
  const deps = {
    ...s.deps,
    receipts,
    receiptCorrections: createInMemoryReceiptCorrectionRepository(),
  };
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

/** releaseScene(주문 B에 3권 배분, OPEN)에서 인도 요청을 만드는 세계 */
export function deliveryScene() {
  const s = releaseScene();
  let seq = 0;
  const request = (
    extra: Partial<DeliverAllocationRequest> = {},
  ): DeliverAllocationRequest => ({
    tenantId: "tenant-a",
    allocationId: s.allocation.id,
    quantity: 1,
    deliveredBy: "김직원",
    deliveredAt: "2026-03-04T06:55:00.000Z",
    idempotencyKey: `dlv-${++seq}`,
    ...extra,
  });
  return {
    ...s,
    /** 인도 요청 */
    request,
    releaseRequest: s.request,
  };
}

/** deliveryScene(주문 B 3권 배분)에서 주문 A(연결 2권)로 옮기는 재배분 요청을 만드는 세계 */
export function reallocationScene() {
  const s = deliveryScene();
  let seq = 0;
  const reallocateRequest = (
    extra: Partial<ReallocateAllocationRequest> = {},
  ): ReallocateAllocationRequest => ({
    tenantId: "tenant-a",
    allocationId: s.allocation.id,
    toOrderId: s.orders[0]!.id,
    toOrderLineId: s.orders[0]!.lines[0]!.lineId,
    quantity: 1,
    reason: "고객 B가 일부 취소, 고객 A에게 우선 배분",
    actorRole: "OWNER",
    actedBy: "점주",
    actedAt: "2026-03-04T06:58:00.000Z",
    idempotencyKey: `rea-${++seq}`,
    ...extra,
  });
  return { ...s, reallocateRequest };
}

export function createInMemoryReceiptCorrectionRepository() {
  const all: ReceiptCorrection[] = [];
  return {
    list(tenantId: string, receiptId: string): ReceiptCorrection[] {
      return all.filter((c) => c.tenantId === tenantId && c.receiptId === receiptId);
    },
    save(correction: ReceiptCorrection): void {
      all.push(correction);
    },
  };
}

/** 4권이 정상 입고(미배분 4권)된 세계에서 입고 정정 요청을 만드는 세계 */
export function correctionScene() {
  const s = allocationScene();
  const { receiptCorrections } = s.deps;
  const deps = s.deps;
  let seq = 0;
  const correctRequest = (
    extra: Partial<CorrectReceiptRequest> = {},
  ): CorrectReceiptRequest => ({
    tenantId: "tenant-a",
    receiptId: s.receipt.id,
    quantity: 1,
    reason: "검수 수량 오기입, 실제로는 3권",
    actorRole: "OWNER",
    correctedBy: "점주",
    correctedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: `cor-${++seq}`,
    ...extra,
  });
  return { ...s, deps, receiptCorrections, correctRequest, allocateRequest: s.request };
}

/** releaseScene(주문 B에 3권 배분, OPEN)에서 주문 취소에 따른 처분 요청을 만드는 세계 */
export function cancellationScene() {
  const s = releaseScene();
  let seq = 0;
  const cancelRequest = (
    extra: Partial<CancelAllocationRequest> = {},
  ): CancelAllocationRequest => ({
    tenantId: "tenant-a",
    allocationId: s.allocation.id,
    quantity: 2,
    reason: "고객 B 주문 일부 취소",
    actorRole: "OWNER",
    cancelledBy: "점주",
    cancelledAt: "2026-03-04T06:52:00.000Z",
    idempotencyKey: `can-${++seq}`,
    ...extra,
  });
  return { ...s, cancelRequest };
}

export function createInMemoryStockIntakeRepository() {
  const all: StockIntake[] = [];
  return {
    list(tenantId: string, cancellationId: string): StockIntake[] {
      return all.filter((i) => i.tenantId === tenantId && i.cancellationId === cancellationId);
    },
    save(intake: StockIntake): void {
      all.push(intake);
    },
  };
}

/** book-1 매장 재고 5권(초기 등록)이 있고, 주문 B의 배분 3권 중 2권이 취소되어 처분 대기인 세계 */
export function intakeScene() {
  const s = cancellationScene();
  const stockMovements = {
    all: [] as import("../../src/inventory/registerInitialStock").StockMovement[],
    list(tenantId: string, bookId: string) {
      return this.all.filter((m) => m.tenantId === tenantId && m.bookId === bookId);
    },
    save(m: import("../../src/inventory/registerInitialStock").StockMovement) {
      this.all.push(m);
    },
  };
  const stockIntakes = createInMemoryStockIntakeRepository();
  const returnRequests = createInMemoryReturnRequestRepository();
  const returnReplies = createInMemoryReturnReplyRepository();
  const returnExceptions = createInMemoryReturnExceptionRepository();
  const returnExceptionResolutions = createInMemoryReturnExceptionResolutionRepository();
  const deps = {
    ...s.deps,
    stockMovements,
    stockIntakes,
    returnRequests,
    returnReplies,
    returnExceptions,
    returnExceptionResolutions,
  };
  registerInitialStock(deps, {
    tenantId: "tenant-a",
    bookId: "book-1",
    quantity: 5,
    actorRole: "OWNER",
    actedBy: "점주",
    actedAt: "2026-03-04T06:00:00.000Z",
    idempotencyKey: "init-intake",
  });
  const cancellation = cancelAllocation(deps, s.cancelRequest({ quantity: 2 }));
  let seq = 0;
  const intakeRequest = (
    extra: Partial<TransferCancelledToStockRequest> = {},
  ): TransferCancelledToStockRequest => ({
    tenantId: "tenant-a",
    cancellationId: cancellation.id,
    quantity: 1,
    actorRole: "OWNER",
    actedBy: "점주",
    actedAt: "2026-03-04T06:58:00.000Z",
    idempotencyKey: `int-${++seq}`,
    ...extra,
  });
  return { ...s, deps, cancellation, stockMovements, stockIntakes, returnRequests, returnReplies, returnExceptions, returnExceptionResolutions, intakeRequest };
}

export function createInMemoryReturnRequestRepository() {
  const all: ReturnRequest[] = [];
  return {
    get(tenantId: string, id: string): ReturnRequest | undefined {
      return all.find((r) => r.tenantId === tenantId && r.id === id);
    },
    list(tenantId: string, cancellationId: string): ReturnRequest[] {
      return all.filter((r) => r.tenantId === tenantId && r.cancellationId === cancellationId);
    },
    save(request: ReturnRequest): void {
      all.push(request);
    },
  };
}

/** intakeScene(처분 대기 2권)에서 공급처 반품을 선택하는 세계 */
export function returnScene() {
  const s = intakeScene();
  const { returnRequests } = s;
  const deps = s.deps;
  let seq = 0;
  const returnRequest = (
    extra: Partial<RequestReturnRequest> = {},
  ): RequestReturnRequest => ({
    tenantId: "tenant-a",
    cancellationId: s.cancellation.id,
    quantity: 2,
    actorRole: "OWNER",
    requestedBy: "점주",
    requestedAt: "2026-03-04T06:59:00.000Z",
    idempotencyKey: `ret-${++seq}`,
    ...extra,
  });
  return { ...s, deps, returnRequests, returnRequest, transferRequest: s.intakeRequest };
}

export function createInMemoryReturnReplyRepository() {
  const all: ReturnReply[] = [];
  return {
    list(tenantId: string, returnRequestId: string): ReturnReply[] {
      return all.filter((r) => r.tenantId === tenantId && r.returnRequestId === returnRequestId);
    },
    save(reply: ReturnReply): void {
      all.push(reply);
    },
  };
}

/** returnScene에서 처분 대기 2권 전부를 반품 요청한 세계 */
export function returnReplyScene() {
  const s = returnScene();
  const { returnReplies, deps } = s;
  const returnRequestRecord = requestReturn(deps, s.returnRequest({ quantity: 2, idempotencyKey: "ret-scene" }));
  let seq = 0;
  const replyRequest = (
    extra: Partial<RecordReturnReplyRequest> = {},
  ): RecordReturnReplyRequest => ({
    tenantId: "tenant-a",
    returnRequestId: returnRequestRecord.id,
    acceptedQuantity: 1,
    rejectedQuantity: 0,
    evidence: "공급처 이메일 2026-03-05 반품 수락 회신",
    repliedBy: "김직원",
    repliedAt: "2026-03-04T06:59:30.000Z",
    idempotencyKey: `rrp-${++seq}`,
    ...extra,
  });
  return { ...s, deps, returnReplies, returnRequestRecord, replyRequest };
}

export function createInMemoryReturnDispatchRepository() {
  const all: ReturnDispatch[] = [];
  return {
    list(tenantId: string, returnRequestId: string): ReturnDispatch[] {
      return all.filter((d) => d.tenantId === tenantId && d.returnRequestId === returnRequestId);
    },
    save(dispatch: ReturnDispatch): void {
      all.push(dispatch);
    },
  };
}

/** 반품 요청 2권 중 공급처가 1권을 수락(1권 미응답)한 세계 */
export function dispatchScene() {
  const s = returnReplyScene();
  const returnDispatches = createInMemoryReturnDispatchRepository();
  const deps = { ...s.deps, returnDispatches };
  recordReturnReply(deps, s.replyRequest({ acceptedQuantity: 1, rejectedQuantity: 0, idempotencyKey: "rep-scene" }));
  let seq = 0;
  const dispatchRequest = (
    extra: Partial<DispatchReturnRequest> = {},
  ): DispatchReturnRequest => ({
    tenantId: "tenant-a",
    returnRequestId: s.returnRequestRecord.id,
    quantity: 1,
    dispatchedBy: "김직원",
    dispatchedAt: "2026-03-04T06:59:45.000Z",
    referenceNumber: "TRK-001",
    idempotencyKey: `dsp-${++seq}`,
    ...extra,
  });
  return { ...s, deps, returnDispatches, dispatchRequest };
}

export function createInMemoryReturnCompletionRepository() {
  const all: ReturnCompletion[] = [];
  return {
    list(tenantId: string, returnRequestId: string): ReturnCompletion[] {
      return all.filter((c) => c.tenantId === tenantId && c.returnRequestId === returnRequestId);
    },
    save(completion: ReturnCompletion): void {
      all.push(completion);
    },
  };
}

/** 반품 요청 2권 중 1권 수락·출고된(공급처 최종 확인 전) 세계 */
export function completionScene() {
  const s = dispatchScene();
  const returnCompletions = createInMemoryReturnCompletionRepository();
  const { returnExceptions } = s;
  const deps = { ...s.deps, returnCompletions };
  dispatchReturn(deps, s.dispatchRequest({ quantity: 1, idempotencyKey: "dsp-scene" }));
  let seq = 0;
  const completeRequest = (
    extra: Partial<CompleteReturnRequest> = {},
  ): CompleteReturnRequest => ({
    tenantId: "tenant-a",
    returnRequestId: s.returnRequestRecord.id,
    quantity: 1,
    evidence: "공급처 반품 입고 확인서 2026-03-06",
    confirmedBy: "김직원",
    confirmedAt: "2026-03-04T06:59:50.000Z",
    idempotencyKey: `cmp-${++seq}`,
    ...extra,
  });
  return { ...s, deps, returnCompletions, returnExceptions, completeRequest };
}

export function createInMemoryReturnExceptionRepository() {
  const all: ReturnException[] = [];
  return {
    get(tenantId: string, id: string): ReturnException | undefined {
      return all.find((e) => e.tenantId === tenantId && e.id === id);
    },
    list(tenantId: string, returnRequestId: string): ReturnException[] {
      return all.filter((e) => e.tenantId === tenantId && e.returnRequestId === returnRequestId);
    },
    save(exception: ReturnException): void {
      all.push(exception);
    },
  };
}

/** completionScene(요청 2, 수락·출고 1, 완료 0)에서 반송·분실을 신고하는 세계 */
export function exceptionScene() {
  const s = completionScene();
  const { returnExceptions, deps } = s;
  let seq = 0;
  const exceptionRequest = (
    extra: Partial<ReportReturnExceptionRequest> = {},
  ): ReportReturnExceptionRequest => ({
    tenantId: "tenant-a",
    returnRequestId: s.returnRequestRecord.id,
    quantity: 1,
    kind: "RETURNED_BACK",
    evidence: "택배사 반송 통보 2026-03-07",
    reportedBy: "김직원",
    reportedAt: "2026-03-04T06:59:55.000Z",
    idempotencyKey: `exc-${++seq}`,
    ...extra,
  });
  return { ...s, deps, returnExceptions, exceptionRequest };
}

export function createInMemoryReturnExceptionResolutionRepository() {
  const all: ReturnExceptionResolution[] = [];
  return {
    list(tenantId: string, returnExceptionId: string): ReturnExceptionResolution[] {
      return all.filter(
        (r) => r.tenantId === tenantId && r.returnExceptionId === returnExceptionId,
      );
    },
    save(resolution: ReturnExceptionResolution): void {
      all.push(resolution);
    },
  };
}

/** exceptionScene에서 출고 1권이 반송 예외로 신고된(미회수) 세계 */
export function resolutionScene() {
  const s = exceptionScene();
  const { returnExceptionResolutions } = s;
  const deps = s.deps;
  const returnException = reportReturnException(
    deps,
    s.exceptionRequest({ quantity: 1, idempotencyKey: "exc-scene" }),
  );
  let seq = 0;
  const resolveRequest = (
    extra: Partial<ResolveReturnExceptionRequest> = {},
  ): ResolveReturnExceptionRequest => ({
    tenantId: "tenant-a",
    returnExceptionId: returnException.id,
    outcome: "RECOVERED",
    quantity: 1,
    evidence: "실물 회수 및 검수 완료 2026-03-08",
    resolvedBy: "김직원",
    resolvedAt: "2026-03-04T06:59:58.000Z",
    idempotencyKey: `res-${++seq}`,
    ...extra,
  });
  return { ...s, deps, returnExceptionResolutions, returnException, resolveRequest };
}

/** 반품 요청 2권 중 1권을 공급처가 거절한(처분 대기 1) 세계 */
export function renegotiationScene() {
  const s = returnReplyScene();
  recordReturnReply(
    s.deps,
    s.replyRequest({ acceptedQuantity: 0, rejectedQuantity: 1, idempotencyKey: "rep-reject-scene" }),
  );
  let seq = 0;
  const renegotiateRequest = (
    extra: Partial<RenegotiateReturnRequest> = {},
  ): RenegotiateReturnRequest => ({
    tenantId: "tenant-a",
    originalRequestId: s.returnRequestRecord.id,
    quantity: 1,
    retryReason: "공급처 담당자 변경, 재협의로 수락 가능성 확인",
    requestedBy: "김직원",
    requestedAt: "2026-03-04T06:59:40.000Z",
    idempotencyKey: `rng-${++seq}`,
    ...extra,
  });
  return { ...s, renegotiateRequest };
}
