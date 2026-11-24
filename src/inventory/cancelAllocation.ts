import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { ReceiptAllocationRepository } from "./allocateReceipt";
import { allocationState } from "./allocationState";
import type { AllocationDeliveryRepository } from "./deliverAllocation";
import type { AllocationReleaseRepository } from "./releaseAllocation";
import type { GoodsReceiptRepository } from "./receiveGoods";
import type { PurchaseOrderRepository } from "../procurement/createPurchaseOrder";

/**
 * 주문 취소에 따른 미인도 배분 해제 기록 (추가 전용). 해제된 물량은 일반 미배분이 아니라
 * 처분 대기(DISPOSITION_PENDING)로 직접 귀속되며 원 입고·주문 참조를 보존한다 (ST-C01, BR-Q21).
 */
export type AllocationCancellation = {
  id: string;
  tenantId: string;
  bookId: string;
  receiptId: string;
  allocationId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  reason: string;
  cancelledBy: string;
  cancelledAt: string;
  recordedAt: string;
};

export type AllocationCancellationRepository = {
  get(tenantId: string, id: string): AllocationCancellation | undefined;
  list(tenantId: string, allocationId: string): AllocationCancellation[];
  save(cancellation: AllocationCancellation): void;
};

export type CancelAllocationDeps = {
  receipts: GoodsReceiptRepository;
  purchaseOrders: PurchaseOrderRepository;
  receiptAllocations: ReceiptAllocationRepository;
  allocationReleases: AllocationReleaseRepository;
  allocationDeliveries: AllocationDeliveryRepository;
  allocationCancellations: AllocationCancellationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CancelAllocationRequest = {
  tenantId: string;
  allocationId: string;
  quantity: number;
  reason: string;
  actorRole: "OWNER" | "STAFF";
  cancelledBy: string;
  cancelledAt: string;
  idempotencyKey: string;
};

export function cancelAllocation(
  deps: CancelAllocationDeps,
  request: CancelAllocationRequest,
): AllocationCancellation {
  // 취소 확정은 점주 업무다. Staff 승인 흐름은 아직 없어 기본 차단한다 (ST-C01 "O/승인 S")
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["reason", "cancelledBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("cancelledAt", request.cancelledAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.cancel-allocation",
      key: request.idempotencyKey,
      payload: {
        allocationId: request.allocationId,
        quantity: request.quantity,
        reason: request.reason,
        cancelledBy: request.cancelledBy,
        cancelledAt: request.cancelledAt,
      },
    },
    () => {
      const allocation = deps.receiptAllocations.get(request.tenantId, request.allocationId);
      if (!allocation) {
        throw new AppError("NOT_FOUND");
      }
      const receipt = deps.receipts.get(request.tenantId, allocation.receiptId)!;
      const po = deps.purchaseOrders.get(request.tenantId, receipt.purchaseOrderId)!;
      const poLine = po.lines.find((l) => l.poLineId === receipt.poLineId)!;
      const { remaining } = allocationState(
        allocation,
        deps.allocationReleases.list(request.tenantId, allocation.id),
        deps.allocationDeliveries.list(request.tenantId, allocation.id),
        deps.allocationCancellations.list(request.tenantId, allocation.id),
      );
      // 이미 인도한 수량은 일반 취소 대상이 아니다 (UC-28)
      if (request.quantity > remaining) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "cancelled quantity must not exceed the allocation's undelivered remaining quantity",
        );
      }
      const cancellation: AllocationCancellation = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: poLine.bookId,
        receiptId: receipt.id,
        allocationId: allocation.id,
        orderId: allocation.orderId,
        orderLineId: allocation.orderLineId,
        quantity: request.quantity,
        reason: request.reason,
        cancelledBy: request.cancelledBy,
        cancelledAt: request.cancelledAt,
        recordedAt: now.toISOString(),
      };
      deps.allocationCancellations.save(cancellation);
      return cancellation;
    },
  );
}
