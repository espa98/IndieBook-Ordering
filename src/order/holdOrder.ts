import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { AppError } from "../errors/AppError";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "./confirmOrderService";
import type { Order } from "./createDraftOrder";

export type HoldOrderDeps = {
  orders: OrderRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type HoldOrderRequest = {
  tenantId: string;
  orderId: string;
  expectedVersion: number;
  reason: string;
  heldBy: string;
  heldAt: string;
  idempotencyKey: string;
};

/** 초안을 보류한다(ST-O02). 보류 중에는 확정할 수 없다(확정 전 조달 금지). 상태는 DRAFT 그대로이고 보류 필드만 채운다. */
export function holdOrder(deps: HoldOrderDeps, request: HoldOrderRequest): Order {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) invalid("expectedVersion", "must be an integer >= 1");
  for (const field of ["orderId", "reason", "heldBy"] as const) {
    if (!isNonEmptyString(request[field])) invalid(field, "must be a non-empty string");
  }
  parseUtcTimestamp("heldAt", request.heldAt, (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "orders.hold",
      key: request.idempotencyKey,
      payload: { orderId: request.orderId, expectedVersion: request.expectedVersion, reason: request.reason, heldAt: request.heldAt },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) throw new AppError("NOT_FOUND");
      if (order.status !== "DRAFT" || order.heldAt !== undefined || order.discardedAt !== undefined) {
        throw new AppError("BUSINESS_INVARIANT", "only a DRAFT order that is not already held can be held");
      }
      if (order.version !== request.expectedVersion) throw new AppError("VERSION_CONFLICT");
      const held: Order = { ...order, version: order.version + 1, heldAt: request.heldAt, holdReason: request.reason, heldBy: request.heldBy };
      deps.orders.save(held);
      return held;
    },
  );
}
