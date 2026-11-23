import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type {
  PurchaseOrder,
  PurchaseOrderRepository,
} from "./createPurchaseOrder";

export type MarkPurchaseOrderReadyDeps = {
  purchaseOrders: PurchaseOrderRepository;
  idempotency: IdempotencyStore;
};

export type MarkPurchaseOrderReadyRequest = {
  tenantId: string;
  purchaseOrderId: string;
  expectedVersion: number;
  idempotencyKey: string;
};

/** 발주를 전달 준비(READY) 상태로 만든다. 발주 버전을 확정할 뿐 외부에 전달하지 않는다 (ST-P04). */
export function markPurchaseOrderReady(
  deps: MarkPurchaseOrderReadyDeps,
  request: MarkPurchaseOrderReadyRequest,
): PurchaseOrder {
  const id: unknown = request.purchaseOrderId;
  if (typeof id !== "string" || id.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "purchaseOrderId must be a non-empty string");
  }
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    throw new AppError("VALIDATION_ERROR", "expectedVersion must be an integer >= 1");
  }

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.po-ready",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        expectedVersion: request.expectedVersion,
      },
    },
    () => {
      const current = deps.purchaseOrders.get(
        request.tenantId,
        request.purchaseOrderId,
      );
      if (!current) {
        // 없는 발주와 타 테넌트의 발주는 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      if (current.status !== "DRAFT") {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "only a DRAFT purchase order can be marked READY",
        );
      }
      if (current.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      const ready: PurchaseOrder = {
        ...current,
        status: "READY",
        version: current.version + 1,
      };
      deps.purchaseOrders.save(ready);
      return ready;
    },
  );
}
