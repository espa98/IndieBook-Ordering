import { AppError } from "../errors/AppError";
import { executeIdempotent } from "../idempotency/executeIdempotent";
import {
  planAllocation,
  validateAllocateRequest,
  type AllocateReceiptDeps,
  type ReceiptAllocation,
} from "./allocateReceipt";
import {
  planRelease,
  validateReleaseRequest,
  type AllocationRelease,
  type ReleaseAllocationDeps,
} from "./releaseAllocation";

export type ReallocateAllocationDeps = AllocateReceiptDeps & ReleaseAllocationDeps;

export type ReallocateAllocationRequest = {
  tenantId: string;
  allocationId: string;
  toOrderId: string;
  toOrderLineId: string;
  quantity: number;
  reason: string;
  actorRole: "OWNER" | "STAFF";
  actedBy: string;
  actedAt: string;
  idempotencyKey: string;
};

export type ReallocateAllocationResult = {
  release: AllocationRelease;
  allocation: ReceiptAllocation;
};

export function reallocateAllocation(
  deps: ReallocateAllocationDeps,
  request: ReallocateAllocationRequest,
): ReallocateAllocationResult {
  const now = (deps.now ?? (() => new Date()))();
  const releaseRequest = {
    tenantId: request.tenantId,
    allocationId: request.allocationId,
    quantity: request.quantity,
    reason: request.reason,
    releasedBy: request.actedBy,
    releasedAt: request.actedAt,
    idempotencyKey: request.idempotencyKey,
  };
  validateReleaseRequest(releaseRequest, now);
  const source = deps.receiptAllocations.get(request.tenantId, request.allocationId);
  // 다른 고객으로의 재배분은 승인이 필요한 고위험 명령이라 Owner만 할 수 있다 (DEC-15)
  if (source && source.orderId !== request.toOrderId && request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.reallocate-allocation",
      key: request.idempotencyKey,
      payload: {
        allocationId: request.allocationId,
        toOrderId: request.toOrderId,
        toOrderLineId: request.toOrderLineId,
        quantity: request.quantity,
        reason: request.reason,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
      },
    },
    () => {
      const release = planRelease(deps, releaseRequest, now);
      const allocateRequest = {
        tenantId: request.tenantId,
        receiptId: source!.receiptId,
        orderId: request.toOrderId,
        orderLineId: request.toOrderLineId,
        quantity: request.quantity,
        allocatedBy: request.actedBy,
        allocatedAt: request.actedAt,
        idempotencyKey: request.idempotencyKey,
      };
      validateAllocateRequest(allocateRequest, now);
      // 아직 저장하지 않은 해제를 반영한 채로 신규 배분의 한도를 검증한다
      const withPendingRelease = {
        ...deps,
        allocationReleases: {
          ...deps.allocationReleases,
          list: (tenantId: string, allocationId: string) => [
            ...deps.allocationReleases.list(tenantId, allocationId),
            ...(allocationId === release.allocationId ? [release] : []),
          ],
        },
      };
      const allocation = planAllocation(withPendingRelease, allocateRequest, now);
      // 두 검증이 모두 통과한 뒤에만 함께 저장한다 (원자 처리)
      deps.allocationReleases.save(release);
      deps.receiptAllocations.save(allocation);
      return { release, allocation };
    },
  );
}
