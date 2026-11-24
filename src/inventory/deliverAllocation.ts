import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { allocationState } from "./allocationState";
import type { AllocationCancellationRepository } from "./cancelAllocation";
import type { AllocationReleaseRepository } from "./releaseAllocation";
import type { ReceiptAllocationRepository } from "./allocateReceipt";

/**
 * 입고 배분 인도 기록 (추가 전용). 고객에게 실제로 넘긴 수령 거래이며
 * 원 배분 기록은 바꾸지 않는다 (ST-R06, BR-Q16).
 */
export type AllocationDelivery = {
  id: string;
  tenantId: string;
  allocationId: string;
  receiptId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  deliveredBy: string;
  deliveredAt: string;
  recordedAt: string;
};

export type AllocationDeliveryRepository = {
  list(tenantId: string, allocationId: string): AllocationDelivery[];
  save(delivery: AllocationDelivery): void;
};

export type DeliverAllocationDeps = {
  receiptAllocations: ReceiptAllocationRepository;
  allocationReleases: AllocationReleaseRepository;
  allocationDeliveries: AllocationDeliveryRepository;
  allocationCancellations: Pick<AllocationCancellationRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type DeliverAllocationRequest = {
  tenantId: string;
  allocationId: string;
  quantity: number;
  deliveredBy: string;
  deliveredAt: string;
  idempotencyKey: string;
};

/** 요청 형식을 검증한다 (저장·조회 없음). */
export function validateDeliverAllocationRequest(
  request: DeliverAllocationRequest,
  now: Date,
): void {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!isNonEmptyString(request.deliveredBy)) {
    invalid("deliveredBy", "must be a non-empty string");
  }
  parseUtcTimestamp("deliveredAt", request.deliveredAt, now);
}

/** 인도 가능 여부를 검증하고 저장할 인도 기록을 만든다. 저장은 하지 않는다. */
export function planAllocationDelivery(
  deps: Omit<DeliverAllocationDeps, "idempotency">,
  request: DeliverAllocationRequest,
  now: Date,
): AllocationDelivery {
  const allocation = deps.receiptAllocations.get(request.tenantId, request.allocationId);
  if (!allocation) {
    throw new AppError("NOT_FOUND");
  }
  const { remaining } = allocationState(
    allocation,
    deps.allocationReleases.list(request.tenantId, allocation.id),
    deps.allocationDeliveries.list(request.tenantId, allocation.id),
    deps.allocationCancellations.list(request.tenantId, allocation.id),
  );
  if (request.quantity > remaining) {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "delivered quantity must not exceed the allocation's remaining quantity",
    );
  }
  const delivery: AllocationDelivery = {
    id: crypto.randomUUID(),
    tenantId: request.tenantId,
    allocationId: allocation.id,
    receiptId: allocation.receiptId,
    orderId: allocation.orderId,
    orderLineId: allocation.orderLineId,
    quantity: request.quantity,
    deliveredBy: request.deliveredBy,
    deliveredAt: request.deliveredAt,
    recordedAt: now.toISOString(),
  };
  return delivery;
}

export function deliverAllocation(
  deps: DeliverAllocationDeps,
  request: DeliverAllocationRequest,
): AllocationDelivery {
  const now = (deps.now ?? (() => new Date()))();
  validateDeliverAllocationRequest(request, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.deliver-allocation",
      key: request.idempotencyKey,
      payload: {
        allocationId: request.allocationId,
        quantity: request.quantity,
        deliveredBy: request.deliveredBy,
        deliveredAt: request.deliveredAt,
      },
    },
    () => {
      const delivery = planAllocationDelivery(deps, request, now);
      deps.allocationDeliveries.save(delivery);
      return delivery;
    },
  );
}
