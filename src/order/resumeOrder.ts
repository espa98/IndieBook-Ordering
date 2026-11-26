import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { AppError } from "../errors/AppError";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "./confirmOrderService";
import type { Order } from "./createDraftOrder";

export type ResumeOrderDeps = {
  orders: OrderRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ResumeOrderRequest = {
  tenantId: string;
  orderId: string;
  expectedVersion: number;
  resumedBy: string;
  resumedAt: string;
  idempotencyKey: string;
};

/** 보류 중인 초안을 재개한다(ST-O02). 보류 필드를 지우고 version을 올린다. 보류·재개 이력은 감사 로그에 남는다. */
export function resumeOrder(deps: ResumeOrderDeps, request: ResumeOrderRequest): Order {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) invalid("expectedVersion", "must be an integer >= 1");
  for (const field of ["orderId", "resumedBy"] as const) {
    if (!isNonEmptyString(request[field])) invalid(field, "must be a non-empty string");
  }
  parseUtcTimestamp("resumedAt", request.resumedAt, (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "orders.resume",
      key: request.idempotencyKey,
      payload: { orderId: request.orderId, expectedVersion: request.expectedVersion, resumedAt: request.resumedAt },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) throw new AppError("NOT_FOUND");
      if (order.status !== "DRAFT" || order.heldAt === undefined || order.discardedAt !== undefined) {
        throw new AppError("BUSINESS_INVARIANT", "only a held DRAFT order can be resumed");
      }
      if (order.version !== request.expectedVersion) throw new AppError("VERSION_CONFLICT");
      const { heldAt: _heldAt, holdReason: _holdReason, heldBy: _heldBy, ...rest } = order;
      const resumed: Order = { ...rest, version: order.version + 1 };
      deps.orders.save(resumed);
      return resumed;
    },
  );
}
