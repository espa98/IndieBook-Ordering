import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { Supplier } from "../procurement/allocateSourcing";
import type { PurchaseOrderRepository } from "../procurement/createPurchaseOrder";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { assertCanManage, type ManagementDelegations } from "./managementGuard";
import type { SupplierChange, SupplierStore } from "./registerSupplier";

export type SetSupplierActiveDeps = {
  suppliers: SupplierStore;
  purchaseOrders: Pick<PurchaseOrderRepository, "list">;
  supplierChanges: { save(change: SupplierChange): void };
  managementDelegations: ManagementDelegations;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type SetSupplierActiveRequest = {
  tenantId: string;
  code: string;
  active: boolean;
  reason: string;
  actorRole: "OWNER" | "STAFF";
  changedBy: string;
  changedAt: string;
  idempotencyKey: string;
};

/**
 * 공급처를 비활성화하거나 복구한다 (ST-B04). 비활성 공급처에는 신규 배정·발주가 막히지만
 * 과거·진행 중 발주는 그대로 보존하고, 비활성화 시점의 진행 중 발주를 이력에 남긴다.
 */
export function setSupplierActive(
  deps: SetSupplierActiveDeps,
  request: SetSupplierActiveRequest,
): Supplier {
  if (typeof request.active !== "boolean") {
    invalid("active", "must be a boolean");
  }
  for (const field of ["reason", "changedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("changedAt", request.changedAt, now);
  assertCanManage(deps.managementDelegations, request, request.changedBy);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "catalog.set-supplier-active",
      key: request.idempotencyKey,
      payload: {
        code: request.code,
        active: request.active,
        reason: request.reason,
        changedBy: request.changedBy,
        changedAt: request.changedAt,
      },
    },
    () => {
      const supplier = deps.suppliers.get(request.tenantId, request.code);
      if (!supplier) {
        throw new AppError("NOT_FOUND");
      }
      if (supplier.active === request.active) {
        throw new AppError("BUSINESS_INVARIANT", "the supplier already has this status");
      }
      const openPurchaseOrderIds = request.active
        ? undefined
        : deps.purchaseOrders
            .list(request.tenantId)
            .filter(
              (po) =>
                po.supplierCode === supplier.code && po.status !== "CANCELLED" && po.status !== "CLOSED",
            )
            .map((po) => po.id);
      const updated: Supplier = { ...supplier, active: request.active, version: (supplier.version ?? 1) + 1 };
      deps.suppliers.save(updated);
      deps.supplierChanges.save({
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        code: supplier.code,
        kind: request.active ? "REACTIVATED" : "DEACTIVATED",
        before: { name: supplier.name, orderChannel: supplier.orderChannel, active: supplier.active },
        after: { name: updated.name, orderChannel: updated.orderChannel, active: updated.active },
        reason: request.reason,
        ...(openPurchaseOrderIds === undefined ? {} : { openPurchaseOrderIds }),
        by: request.changedBy,
        at: request.changedAt,
      });
      return updated;
    },
  );
}
