import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { PurchaseOrderRepository } from "../procurement/createPurchaseOrder";
import type { GoodsReceiptRepository } from "./receiveGoods";

/** 입고 정상량을 고객 주문 품목에 배분한 기록 (추가 전용). */
export type ReceiptAllocation = {
  id: string;
  tenantId: string;
  receiptId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  allocatedBy: string;
  allocatedAt: string;
  recordedAt: string;
};

export type ReceiptAllocationRepository = {
  list(tenantId: string, receiptId: string): ReceiptAllocation[];
  save(allocation: ReceiptAllocation): void;
};

export type AllocateReceiptDeps = {
  purchaseOrders: PurchaseOrderRepository;
  receipts: GoodsReceiptRepository;
  receiptAllocations: ReceiptAllocationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type AllocateReceiptRequest = {
  tenantId: string;
  receiptId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  allocatedBy: string;
  allocatedAt: string;
  idempotencyKey: string;
};

export function allocateReceipt(
  deps: AllocateReceiptDeps,
  request: AllocateReceiptRequest,
): ReceiptAllocation {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["orderId", "orderLineId", "allocatedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("allocatedAt", request.allocatedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.allocate-receipt",
      key: request.idempotencyKey,
      payload: {
        receiptId: request.receiptId,
        orderId: request.orderId,
        orderLineId: request.orderLineId,
        quantity: request.quantity,
        allocatedBy: request.allocatedBy,
        allocatedAt: request.allocatedAt,
      },
    },
    () => {
      const receipt = deps.receipts.get(request.tenantId, request.receiptId);
      if (!receipt) {
        throw new AppError("NOT_FOUND");
      }
      const po = deps.purchaseOrders.get(request.tenantId, receipt.purchaseOrderId)!;
      const poLine = po.lines.find((l) => l.poLineId === receipt.poLineId)!;
      const link = poLine.links.find(
        (l) => l.orderId === request.orderId && l.orderLineId === request.orderLineId,
      );
      if (!link) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "order line is not linked to the receipt's purchase order line",
        );
      }
      const existing = deps.receiptAllocations.list(request.tenantId, receipt.id);
      const allocated = existing.reduce((sum, a) => sum + a.quantity, 0);
      if (allocated + request.quantity > receipt.normalQuantity) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "allocated quantity must not exceed the receipt's normal quantity",
        );
      }
      const forLine = deps.receipts
        .list(request.tenantId, po.id)
        .filter((r) => r.poLineId === receipt.poLineId)
        .flatMap((r) => deps.receiptAllocations.list(request.tenantId, r.id))
        .filter((a) => a.orderId === request.orderId && a.orderLineId === request.orderLineId)
        .reduce((sum, a) => sum + a.quantity, 0);
      if (forLine + request.quantity > link.quantity) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "allocated quantity must not exceed the order line's purchase order link quantity",
        );
      }
      const allocation: ReceiptAllocation = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        receiptId: request.receiptId,
        orderId: request.orderId,
        orderLineId: request.orderLineId,
        quantity: request.quantity,
        allocatedBy: request.allocatedBy,
        allocatedAt: request.allocatedAt,
        recordedAt: now.toISOString(),
      };
      deps.receiptAllocations.save(allocation);
      return allocation;
    },
  );
}
