import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { OrderChannel, Supplier, SupplierRepository } from "../procurement/allocateSourcing";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { assertCanManage, type ManagementDelegations } from "./managementGuard";

/** 공급처 변경 이력 (추가 전용, ST-B04). */
export type SupplierChange = {
  id: string;
  tenantId: string;
  code: string;
  kind: "REGISTERED" | "UPDATED" | "DEACTIVATED" | "REACTIVATED";
  before?: { name?: string; orderChannel?: OrderChannel; active: boolean };
  after: { name?: string; orderChannel?: OrderChannel; active: boolean };
  reason?: string;
  /** 비활성화 시점에 아직 진행 중이던 발주. 발주 자체는 바꾸지 않는다 */
  openPurchaseOrderIds?: string[];
  by: string;
  at: string;
};

export type SupplierStore = SupplierRepository & {
  list(tenantId: string): Supplier[];
  save(supplier: Supplier): void;
};

export const ORDER_CHANNELS: readonly OrderChannel[] = ["WEB", "EMAIL", "PHONE", "MESSENGER", "FILE", "API"];

export type RegisterSupplierDeps = {
  suppliers: SupplierStore;
  supplierChanges: { save(change: SupplierChange): void };
  managementDelegations: ManagementDelegations;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RegisterSupplierRequest = {
  tenantId: string;
  code: string;
  name: string;
  orderChannel: OrderChannel;
  actorRole: "OWNER" | "STAFF";
  registeredBy: string;
  registeredAt: string;
  idempotencyKey: string;
};

export function validateSupplierFields(fields: { name?: string; orderChannel?: OrderChannel }): void {
  if (fields.name !== undefined && !isNonEmptyString(fields.name)) {
    invalid("name", "must be a non-empty string");
  }
  if (fields.orderChannel !== undefined && !ORDER_CHANNELS.includes(fields.orderChannel)) {
    invalid("orderChannel", `must be one of ${ORDER_CHANNELS.join(", ")}`);
  }
}

export function registerSupplier(
  deps: RegisterSupplierDeps,
  request: RegisterSupplierRequest,
): Supplier {
  if (typeof request.code !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(request.code)) {
    invalid("code", "must be 1-32 lowercase letters, digits or hyphens");
  }
  validateSupplierFields({ name: request.name ?? "", orderChannel: request.orderChannel });
  if (request.orderChannel === undefined) invalid("orderChannel", "is required");
  if (!isNonEmptyString(request.registeredBy)) {
    invalid("registeredBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("registeredAt", request.registeredAt, now);
  assertCanManage(deps.managementDelegations, request, request.registeredBy);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "catalog.register-supplier",
      key: request.idempotencyKey,
      payload: {
        code: request.code,
        name: request.name,
        orderChannel: request.orderChannel,
        registeredBy: request.registeredBy,
        registeredAt: request.registeredAt,
      },
    },
    () => {
      if (deps.suppliers.get(request.tenantId, request.code)) {
        throw new AppError("BUSINESS_INVARIANT", "a supplier with this code already exists");
      }
      const supplier: Supplier = {
        tenantId: request.tenantId,
        code: request.code,
        active: true,
        name: request.name,
        orderChannel: request.orderChannel,
        version: 1,
      };
      deps.suppliers.save(supplier);
      deps.supplierChanges.save({
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        code: supplier.code,
        kind: "REGISTERED",
        after: { name: supplier.name, orderChannel: supplier.orderChannel, active: true },
        by: request.registeredBy,
        at: request.registeredAt,
      });
      return supplier;
    },
  );
}
