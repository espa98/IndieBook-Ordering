import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { allocationState } from "./allocationState";
import type { AllocationDeliveryRepository } from "./deliverAllocation";
import type { ReceiptAllocationRepository } from "./allocateReceipt";

/** 입고 배분 해제 기록 (추가 전용). 원 배분 기록은 바꾸지 않는다 (BR-Q16). */
export type AllocationRelease = {
  id: string;
  tenantId: string;
  allocationId: string;
  quantity: number;
  reason: string;
  releasedBy: string;
  releasedAt: string;
  recordedAt: string;
};

export type AllocationReleaseRepository = {
  list(tenantId: string, allocationId: string): AllocationRelease[];
  save(release: AllocationRelease): void;
};

export type ReleaseAllocationDeps = {
  receiptAllocations: ReceiptAllocationRepository;
  allocationReleases: AllocationReleaseRepository;
  allocationDeliveries: AllocationDeliveryRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ReleaseAllocationRequest = {
  tenantId: string;
  allocationId: string;
  quantity: number;
  reason: string;
  releasedBy: string;
  releasedAt: string;
  idempotencyKey: string;
};

export function releaseAllocation(
  deps: ReleaseAllocationDeps,
  request: ReleaseAllocationRequest,
): AllocationRelease {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["reason", "releasedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("releasedAt", request.releasedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.release-allocation",
      key: request.idempotencyKey,
      payload: {
        allocationId: request.allocationId,
        quantity: request.quantity,
        reason: request.reason,
        releasedBy: request.releasedBy,
        releasedAt: request.releasedAt,
      },
    },
    () => {
      const allocation = deps.receiptAllocations.get(request.tenantId, request.allocationId);
      if (!allocation) {
        throw new AppError("NOT_FOUND");
      }
      const { remaining } = allocationState(
        allocation,
        deps.allocationReleases.list(request.tenantId, allocation.id),
        deps.allocationDeliveries.list(request.tenantId, allocation.id),
      );
      if (request.quantity > remaining) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "released quantity must not exceed the allocation's remaining quantity",
        );
      }
      const release: AllocationRelease = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        allocationId: request.allocationId,
        quantity: request.quantity,
        reason: request.reason,
        releasedBy: request.releasedBy,
        releasedAt: request.releasedAt,
        recordedAt: now.toISOString(),
      };
      deps.allocationReleases.save(release);
      return release;
    },
  );
}
