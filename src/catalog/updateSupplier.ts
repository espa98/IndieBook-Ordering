import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { OrderChannel, Supplier } from "../procurement/allocateSourcing";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { assertCanManage, type ManagementDelegations } from "./managementGuard";
import { validateSupplierFields, type SupplierChange, type SupplierStore } from "./registerSupplier";

export type UpdateSupplierDeps = {
  suppliers: SupplierStore;
  supplierChanges: { save(change: SupplierChange): void };
  managementDelegations: ManagementDelegations;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type UpdateSupplierRequest = {
  tenantId: string;
  code: string;
  expectedVersion: number;
  changes: { name?: string; orderChannel?: OrderChannel };
  reason: string;
  actorRole: "OWNER" | "STAFF";
  changedBy: string;
  changedAt: string;
  idempotencyKey: string;
};

const view = (s: Supplier) => ({ name: s.name, orderChannel: s.orderChannel, active: s.active });

/** 공급처의 이름·발주 방식을 수정한다 (ST-B04, SUP-002). 이전 값은 변경 이력에 남는다. */
export function updateSupplier(deps: UpdateSupplierDeps, request: UpdateSupplierRequest): Supplier {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    invalid("expectedVersion", "must be an integer >= 1");
  }
  const changes = request.changes ?? {};
  if (!("name" in changes) && !("orderChannel" in changes)) {
    invalid("changes", "at least one field must change");
  }
  validateSupplierFields(changes);
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
      operation: "catalog.update-supplier",
      key: request.idempotencyKey,
      payload: {
        code: request.code,
        expectedVersion: request.expectedVersion,
        changes,
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
      const version = supplier.version ?? 1;
      if (version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      const updated: Supplier = { ...supplier, ...changes, version: version + 1 };
      deps.suppliers.save(updated);
      deps.supplierChanges.save({
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        code: supplier.code,
        kind: "UPDATED",
        before: view(supplier),
        after: view(updated),
        reason: request.reason,
        by: request.changedBy,
        at: request.changedAt,
      });
      return updated;
    },
  );
}
