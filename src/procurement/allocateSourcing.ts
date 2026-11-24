import { AppError } from "../errors/AppError";
import { assertOrderOpenForTransactions } from "../order/orderGuards";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { OrderRepository } from "../order/confirmOrderService";
import type { DuplicateRiskApprovalRepository } from "./approveDuplicateRisk";
import { openSupplierObligations, type SupplierObligationDeps } from "./supplierObligations";

export type OrderChannel = "WEB" | "EMAIL" | "PHONE" | "MESSENGER" | "FILE" | "API";

export type Supplier = {
  tenantId: string;
  code: string;
  active: boolean;
  /** 공급처 관리(ST-B04)로 등록된 경우에만 있다 */
  name?: string;
  orderChannel?: OrderChannel;
  version?: number;
};

export type SupplierRepository = {
  get(tenantId: string, code: string): Supplier | undefined;
};

/** 조달 배정: 주문 품목의 수량 일부를 공급처 발주 경로로 지정한다 (ST-P01). */
export type SourcingAllocation = {
  id: string;
  tenantId: string;
  orderId: string;
  lineId: string;
  supplierCode: string;
  quantity: number;
  status: "ACTIVE" | "RELEASED";
};

export type SourcingAllocationRepository = {
  get(tenantId: string, id: string): SourcingAllocation | undefined;
  list(tenantId: string): SourcingAllocation[];
  save(allocation: SourcingAllocation): void;
};

export type AllocateSourcingDeps = {
  orders: OrderRepository;
  suppliers: SupplierRepository;
  allocations: SourcingAllocationRepository;
  /** 연결하면, 이전 공급처 의무가 남은 품목의 재조달은 중복 위험 승인을 요구한다 (BR-P05) */
  supplierObligations?: SupplierObligationDeps & {
    duplicateRiskApprovals?: Pick<DuplicateRiskApprovalRepository, "list">;
  };
  idempotency: IdempotencyStore;
};

export type AllocateSourcingRequest = {
  tenantId: string;
  orderId: string;
  lineId: string;
  supplierCode: string;
  quantity: number;
  idempotencyKey: string;
};

export function allocateSourcing(
  deps: AllocateSourcingDeps,
  request: AllocateSourcingRequest,
): SourcingAllocation {
  for (const field of ["orderId", "lineId", "supplierCode"] as const) {
    const value: unknown = request[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    throw new AppError("VALIDATION_ERROR", "quantity must be an integer >= 1");
  }

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.allocate",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        lineId: request.lineId,
        supplierCode: request.supplierCode,
        quantity: request.quantity,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      const line = order?.lines.find((l) => l.lineId === request.lineId);
      if (!order || !line) {
        // 없는 주문·타 테넌트 주문·주문에 속하지 않은 품목을 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      assertOrderOpenForTransactions(order, "sourcing");
      const supplier = deps.suppliers.get(request.tenantId, request.supplierCode);
      if (!supplier) {
        // 타 테넌트의 공급처도 같은 NOT_FOUND라서 존재 여부가 드러나지 않는다
        throw new AppError("NOT_FOUND");
      }
      if (!supplier.active) {
        throw new AppError("BUSINESS_INVARIANT", "supplier is not active");
      }
      if (deps.supplierObligations) {
        const approvals =
          deps.supplierObligations.duplicateRiskApprovals?.list(request.tenantId, order.id) ?? [];
        const unapproved = openSupplierObligations(
          deps.supplierObligations,
          request.tenantId,
          order.id,
          line.lineId,
        ).filter(
          (o) =>
            !approvals.some(
              (a) =>
                a.lineId === line.lineId &&
                a.purchaseOrderId === o.purchaseOrderId &&
                a.poLineId === o.poLineId,
            ),
        );
        if (unapproved.length > 0) {
          throw new AppError(
            "BUSINESS_INVARIANT",
            "a duplicate-risk approval is required to re-source a line with an open supplier obligation",
          );
        }
      }
      const alreadyAllocated = deps.allocations
        .list(request.tenantId)
        .filter(
          (a) =>
            a.orderId === request.orderId &&
            a.lineId === request.lineId &&
            a.status === "ACTIVE",
        )
        .reduce((sum, a) => sum + a.quantity, 0);
      if (alreadyAllocated + request.quantity > line.quantity) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "active sourcing quantity would exceed the order line quantity",
        );
      }
      const allocation: SourcingAllocation = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: request.orderId,
        lineId: request.lineId,
        supplierCode: request.supplierCode,
        quantity: request.quantity,
        status: "ACTIVE",
      };
      deps.allocations.save(allocation);
      return allocation;
    },
  );
}
