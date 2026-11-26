import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { AppError } from "../errors/AppError";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "./confirmOrderService";
import type { Order } from "./createDraftOrder";

export type DiscardOrderDeps = {
  orders: OrderRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type DiscardOrderRequest = {
  tenantId: string;
  orderId: string;
  expectedVersion: number;
  reason: string;
  discardedBy: string;
  discardedAt: string;
  idempotencyKey: string;
};

/** 초안(보류 중이어도)을 폐기한다(ST-O09). 외부 거래가 없는 초안만 대상이며 이력은 지우지 않고 폐기 필드만 채운다. */
export function discardOrder(deps: DiscardOrderDeps, request: DiscardOrderRequest): Order {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) invalid("expectedVersion", "must be an integer >= 1");
  for (const field of ["orderId", "reason", "discardedBy"] as const) {
    if (!isNonEmptyString(request[field])) invalid(field, "must be a non-empty string");
  }
  parseUtcTimestamp("discardedAt", request.discardedAt, (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "orders.discard",
      key: request.idempotencyKey,
      payload: { orderId: request.orderId, expectedVersion: request.expectedVersion, reason: request.reason, discardedAt: request.discardedAt },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) throw new AppError("NOT_FOUND");
      if (order.status !== "DRAFT" || order.discardedAt !== undefined) {
        throw new AppError("BUSINESS_INVARIANT", "only a DRAFT order that is not already discarded can be discarded");
      }
      if (order.version !== request.expectedVersion) throw new AppError("VERSION_CONFLICT");
      const { heldAt: _heldAt, holdReason: _holdReason, heldBy: _heldBy, ...rest } = order;
      const discarded: Order = {
        ...rest,
        version: order.version + 1,
        discardedAt: request.discardedAt,
        discardReason: request.reason,
        discardedBy: request.discardedBy,
      };
      deps.orders.save(discarded);
      return discarded;
    },
  );
}
