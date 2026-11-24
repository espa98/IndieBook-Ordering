import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { PurchaseOrder, PurchaseOrderRepository } from "./createPurchaseOrder";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "./validation";

export type CancelUndeliveredPurchaseOrderDeps = {
  purchaseOrders: PurchaseOrderRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CancelUndeliveredPurchaseOrderRequest = {
  tenantId: string;
  purchaseOrderId: string;
  expectedVersion: number;
  reason: string;
  cancelledBy: string;
  cancelledAt: string;
  idempotencyKey: string;
};

/**
 * 공급처에 전달하지 않은 발주(DRAFT/READY)를 취소한다. 외부 의무가 없으므로 공급처 수락이 필요 없다 (ST-P09).
 * 취소된 발주는 중복 연결 검사에서 빠지므로 연결됐던 배정은 ACTIVE로 남아 새 발주에 다시 연결할 수 있다.
 */
export function cancelUndeliveredPurchaseOrder(
  deps: CancelUndeliveredPurchaseOrderDeps,
  request: CancelUndeliveredPurchaseOrderRequest,
): PurchaseOrder {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    invalid("expectedVersion", "must be an integer >= 1");
  }
  for (const field of ["purchaseOrderId", "reason", "cancelledBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("cancelledAt", request.cancelledAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.cancel-undelivered-po",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        expectedVersion: request.expectedVersion,
        reason: request.reason,
        cancelledBy: request.cancelledBy,
        cancelledAt: request.cancelledAt,
      },
    },
    () => {
      const po = deps.purchaseOrders.get(request.tenantId, request.purchaseOrderId);
      if (!po) {
        throw new AppError("NOT_FOUND");
      }
      if (po.status !== "DRAFT" && po.status !== "READY") {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "only an undelivered (DRAFT or READY) purchase order can be cancelled this way",
        );
      }
      if (po.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      const cancelled: PurchaseOrder = {
        ...po,
        status: "CANCELLED",
        version: po.version + 1,
        cancelledAt: request.cancelledAt,
        cancelledBy: request.cancelledBy,
        cancelReason: request.reason,
      };
      deps.purchaseOrders.save(cancelled);
      return cancelled;
    },
  );
}
