import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { confirmOrder } from "./confirmOrder";
import type { Order } from "./createDraftOrder";

export type OrderRepository = {
  get(tenantId: string, orderId: string): Order | undefined;
  list(tenantId: string): Order[];
  save(order: Order): void;
};

export type ConfirmOrderDeps = {
  orders: OrderRepository;
  idempotency: IdempotencyStore;
  issueDisplayNumber: (tenantId: string) => number;
};

export type ConfirmOrderRequest = {
  tenantId: string;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
};

export function confirmOrderService(
  deps: ConfirmOrderDeps,
  request: ConfirmOrderRequest,
): Order {
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "orders.confirm",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        expectedVersion: request.expectedVersion,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) {
        throw new Error("NOT_FOUND");
      }
      const confirmed = confirmOrder(order, {
        expectedVersion: request.expectedVersion,
        issueDisplayNumber: deps.issueDisplayNumber,
      });
      deps.orders.save(confirmed);
      return confirmed;
    },
  );
}
