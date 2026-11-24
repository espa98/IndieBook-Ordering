import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { SourcingAllocationRepository } from "./allocateSourcing";
import type { PurchaseOrderRepository } from "./createPurchaseOrder";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "./validation";

/** 이미 전달된 발주에 남는 외부 의무. 배정을 해제해도 발주 자체는 바뀌지 않는다 (ST-P02, BR-P05). */
export type RetainedObligation = {
  purchaseOrderId: string;
  poLineId: string;
  quantity: number;
};

/** 조달 배정 해제 기록 (추가 전용, ST-P02). */
export type SourcingRelease = {
  id: string;
  tenantId: string;
  allocationId: string;
  orderId: string;
  lineId: string;
  supplierCode: string;
  quantity: number;
  reason: string;
  retainedObligations: RetainedObligation[];
  releasedBy: string;
  releasedAt: string;
  recordedAt: string;
};

export type SourcingReleaseRepository = {
  list(tenantId: string, allocationId: string): SourcingRelease[];
  save(release: SourcingRelease): void;
};

export type ReleaseSourcingDeps = {
  allocations: SourcingAllocationRepository;
  purchaseOrders: PurchaseOrderRepository;
  sourcingReleases: SourcingReleaseRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ReleaseSourcingRequest = {
  tenantId: string;
  allocationId: string;
  reason: string;
  releasedBy: string;
  releasedAt: string;
  idempotencyKey: string;
};

export function releaseSourcing(
  deps: ReleaseSourcingDeps,
  request: ReleaseSourcingRequest,
): SourcingRelease {
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
      operation: "procurement.release-sourcing",
      key: request.idempotencyKey,
      payload: {
        allocationId: request.allocationId,
        reason: request.reason,
        releasedBy: request.releasedBy,
        releasedAt: request.releasedAt,
      },
    },
    () => {
      const allocation = deps.allocations.get(request.tenantId, request.allocationId);
      if (!allocation) {
        throw new AppError("NOT_FOUND");
      }
      if (allocation.status !== "ACTIVE") {
        throw new AppError("BUSINESS_INVARIANT", "only an ACTIVE allocation can be released");
      }
      // 이 배정이 연결된, 취소되지 않은 발주를 찾는다 (PO-009)
      const linked = deps.purchaseOrders
        .list(request.tenantId)
        .filter((po) => po.status !== "CANCELLED")
        .flatMap((po) =>
          po.lines.flatMap((line) =>
            line.links
              .filter((link) => link.allocationId === allocation.id)
              .map((link) => ({ po, line, link })),
          ),
        );
      // 아직 전달되지 않은 발주는 외부 의무가 없으니 먼저 발주를 취소해야 한다 (ST-P09)
      if (linked.some(({ po }) => po.status === "DRAFT" || po.status === "READY")) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "the allocation is linked to an undelivered purchase order; cancel that order first",
        );
      }
      // 이미 전달된 발주는 바꾸지 않고, 남는 외부 의무로 기록한다
      const retainedObligations = linked.map(({ po, line, link }) => ({
        purchaseOrderId: po.id,
        poLineId: line.poLineId,
        quantity: link.quantity,
      }));
      const release: SourcingRelease = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        allocationId: allocation.id,
        orderId: allocation.orderId,
        lineId: allocation.lineId,
        supplierCode: allocation.supplierCode,
        quantity: allocation.quantity,
        reason: request.reason,
        retainedObligations,
        releasedBy: request.releasedBy,
        releasedAt: request.releasedAt,
        recordedAt: now.toISOString(),
      };
      deps.allocations.save({ ...allocation, status: "RELEASED" });
      deps.sourcingReleases.save(release);
      return release;
    },
  );
}
