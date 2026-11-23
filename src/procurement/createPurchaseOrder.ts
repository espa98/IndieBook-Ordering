import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { OrderRepository } from "../order/confirmOrderService";
import type {
  SourcingAllocationRepository,
  SupplierRepository,
} from "./allocateSourcing";

/** 발주 품목과 원 주문 품목의 N:M 연결 (PO-009). 수량은 조달 배정 수량이다. */
export type PoLink = {
  allocationId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
};

export type PoLine = {
  poLineId: string;
  bookId: string;
  /** 연결된 배정 수량의 합 (파생값, 별도로 입력하지 않는다) */
  quantity: number;
  links: PoLink[];
};

/** 실제 전달 사실. 공급처 접수 확인(ACKNOWLEDGED)과 구분한다 (PO-005). */
export type PoDelivery = {
  method: "WEB" | "EMAIL" | "PHONE" | "MESSENGER" | "FILE" | "API";
  /** 업무 발생 시각: 실제로 전달한 시각(사용자 입력) */
  deliveredAt: string;
  /** 서버 기록 시각 */
  recordedAt: string;
  /** 전달 담당자 */
  deliveredBy: string;
  /** 확인번호·참조번호(선택) */
  referenceNumber?: string;
  /** 전달한 발주 버전 */
  poVersion: number;
  /** 전달한 파일의 출력 버전(선택) */
  fileVersion?: number;
};

export type PurchaseOrder = {
  id: string;
  tenantId: string;
  supplierCode: string;
  status: "DRAFT" | "READY" | "SENT" | "ACKNOWLEDGED" | "CANCELLED";
  version: number;
  lines: PoLine[];
  delivery?: PoDelivery;
};

export type PurchaseOrderRepository = {
  get(tenantId: string, id: string): PurchaseOrder | undefined;
  list(tenantId: string): PurchaseOrder[];
  save(order: PurchaseOrder): void;
};

export type CreatePurchaseOrderDeps = {
  orders: OrderRepository;
  suppliers: SupplierRepository;
  allocations: SourcingAllocationRepository;
  purchaseOrders: PurchaseOrderRepository;
  idempotency: IdempotencyStore;
};

export type CreatePurchaseOrderRequest = {
  tenantId: string;
  supplierCode: string;
  allocationIds: string[];
  idempotencyKey: string;
};

export function createPurchaseOrder(
  deps: CreatePurchaseOrderDeps,
  request: CreatePurchaseOrderRequest,
): PurchaseOrder {
  const supplierCode: unknown = request.supplierCode;
  if (typeof supplierCode !== "string" || supplierCode.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "supplierCode must be a non-empty string");
  }
  const ids: unknown = request.allocationIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== "string" || id.trim() === "") ||
    new Set(ids).size !== ids.length
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "allocationIds must be a non-empty array of unique non-empty strings",
    );
  }

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.create-po",
      key: request.idempotencyKey,
      payload: {
        supplierCode: request.supplierCode,
        allocationIds: request.allocationIds,
      },
    },
    () => {
      const supplier = deps.suppliers.get(request.tenantId, request.supplierCode);
      if (!supplier) {
        // 없는 공급처와 타 테넌트의 공급처는 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      if (!supplier.active) {
        throw new AppError("BUSINESS_INVARIANT", "supplier is not active");
      }

      // 취소되지 않은 발주에 이미 연결된 배정은 다시 연결할 수 없다 (중복 발주 방지, PO-009)
      const linkedAllocationIds = new Set(
        deps.purchaseOrders
          .list(request.tenantId)
          .filter((po) => po.status !== "CANCELLED")
          .flatMap((po) => po.lines.flatMap((line) => line.links))
          .map((link) => link.allocationId),
      );

      // 같은 도서의 배정을 발주 품목 하나로 합산하고, 원 주문별 연결은 유지한다 (PO-003)
      const lineByBook = new Map<string, PoLine>();
      for (const allocationId of request.allocationIds) {
        const allocation = deps.allocations.get(request.tenantId, allocationId);
        if (!allocation) {
          // 없는 배정과 타 테넌트의 배정은 구별할 수 없게 같은 오류로 낸다
          throw new AppError("NOT_FOUND");
        }
        if (allocation.status !== "ACTIVE") {
          throw new AppError("BUSINESS_INVARIANT", "allocation is not ACTIVE");
        }
        if (linkedAllocationIds.has(allocation.id)) {
          throw new AppError(
            "BUSINESS_INVARIANT",
            "allocation is already linked to an active purchase order",
          );
        }
        if (allocation.supplierCode !== request.supplierCode) {
          throw new AppError(
            "BUSINESS_INVARIANT",
            "allocation belongs to a different supplier",
          );
        }
        const order = deps.orders.get(request.tenantId, allocation.orderId);
        const orderLine = order?.lines.find((l) => l.lineId === allocation.lineId);
        if (!order || !orderLine) {
          throw new AppError("NOT_FOUND");
        }
        const line =
          lineByBook.get(orderLine.bookId) ??
          ({
            poLineId: crypto.randomUUID(),
            bookId: orderLine.bookId,
            quantity: 0,
            links: [],
          } satisfies PoLine);
        line.quantity += allocation.quantity;
        line.links.push({
          allocationId: allocation.id,
          orderId: allocation.orderId,
          orderLineId: allocation.lineId,
          quantity: allocation.quantity,
        });
        lineByBook.set(orderLine.bookId, line);
      }

      const purchaseOrder: PurchaseOrder = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        supplierCode: request.supplierCode,
        status: "DRAFT",
        version: 1,
        lines: [...lineByBook.values()],
      };
      deps.purchaseOrders.save(purchaseOrder);
      return purchaseOrder;
    },
  );
}
