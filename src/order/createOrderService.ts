import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { addOrderLine } from "./addOrderLine";
import type { OrderRepository } from "./confirmOrderService";
import {
  createDraftOrder,
  type NewOrderLine,
  type Order,
} from "./createDraftOrder";

export type CreateOrderDeps = {
  orders: OrderRepository;
  idempotency: IdempotencyStore;
};

export type CreateOrderRequest = {
  tenantId: string;
  idempotencyKey: string;
  lines: NewOrderLine[];
};

export function createOrderService(
  deps: CreateOrderDeps,
  request: CreateOrderRequest,
): Order {
  if (
    !Array.isArray(request.lines) ||
    request.lines.some(
      (line) =>
        line === null || typeof line !== "object" || Array.isArray(line),
    )
  ) {
    throw new AppError("VALIDATION_ERROR", "lines must be an array of objects");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "orders.create",
      key: request.idempotencyKey,
      payload: { lines: request.lines },
    },
    () => {
      const order = request.lines.reduce(
        addOrderLine,
        createDraftOrder({ tenantId: request.tenantId }),
      );
      deps.orders.save(order);
      return order;
    },
  );
}
