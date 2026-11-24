import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { allocationState } from "./allocationState";
import type { ReceiptCorrectionRepository } from "./correctReceipt";
import type { AllocationReleaseRepository } from "./releaseAllocation";
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
  get(tenantId: string, id: string): ReceiptAllocation | undefined;
  listByOrder(tenantId: string, orderId: string): ReceiptAllocation[];
  list(tenantId: string, receiptId: string): ReceiptAllocation[];
  save(allocation: ReceiptAllocation): void;
};

export type AllocateReceiptDeps = {
  purchaseOrders: PurchaseOrderRepository;
  receipts: GoodsReceiptRepository;
  receiptAllocations: ReceiptAllocationRepository;
  allocationReleases: AllocationReleaseRepository;
  receiptCorrections: ReceiptCorrectionRepository;
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

/** 요청 형식을 검증한다 (저장·조회 없음). */
export function validateAllocateRequest(
  request: AllocateReceiptRequest,
  now: Date,
): void {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["orderId", "orderLineId", "allocatedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  parseUtcTimestamp("allocatedAt", request.allocatedAt, now);
}

/** 배분 한도를 모두 검증하고 저장할 배분 기록을 만든다. 저장은 하지 않는다. */
export function planAllocation(
  deps: Omit<AllocateReceiptDeps, "idempotency">,
  request: AllocateReceiptRequest,
  now: Date,
): ReceiptAllocation {
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
  // 해제된 만큼은 다시 배분할 수 있으므로 순배분(잔량)으로 센다 (BR-Q16)
  const netOf = (allocations: ReceiptAllocation[]) =>
    allocations.reduce(
      (sum, a) =>
        sum +
        allocationState(
          a,
          deps.allocationReleases.list(request.tenantId, a.id),
        ).remaining,
      0,
    );
  const allocated = netOf(deps.receiptAllocations.list(request.tenantId, receipt.id));
  const netNormal =
    receipt.normalQuantity -
    deps.receiptCorrections
      .list(request.tenantId, receipt.id)
      .reduce((sum, c) => sum + c.quantity, 0);
  if (allocated + request.quantity > netNormal) {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "allocated quantity must not exceed the receipt's normal quantity",
    );
  }
  const forLine = netOf(
    deps.receipts
      .list(request.tenantId, po.id)
      .filter((r) => r.poLineId === receipt.poLineId)
      .flatMap((r) => deps.receiptAllocations.list(request.tenantId, r.id))
      .filter(
        (a) => a.orderId === request.orderId && a.orderLineId === request.orderLineId,
      ),
  );
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
  return allocation;
}

export function allocateReceipt(
  deps: AllocateReceiptDeps,
  request: AllocateReceiptRequest,
): ReceiptAllocation {
  const now = (deps.now ?? (() => new Date()))();
  validateAllocateRequest(request, now);
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
      const allocation = planAllocation(deps, request, now);
      deps.receiptAllocations.save(allocation);
      return allocation;
    },
  );
}
