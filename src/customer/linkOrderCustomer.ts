import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { Customer } from "./registerCustomer";

/** 주문과 고객의 연결(추가 전용). 주문의 현재 고객은 가장 최근 연결이다 */
export type OrderCustomerLink = { id: string; tenantId: string; orderId: string; customerId: string; linkedBy: string; linkedAt: string };

export type LinkOrderCustomerDeps = {
  customers: { get(tenantId: string, id: string): Customer | undefined };
  orders: { get(tenantId: string, id: string): { id: string; closedAt?: string; cancelledAt?: string; discardedAt?: string } | undefined };
  orderCustomerLinks: { current(tenantId: string, orderId: string): OrderCustomerLink | undefined; save(link: OrderCustomerLink): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type LinkOrderCustomerRequest = {
  tenantId: string;
  orderId: string;
  customerId: string;
  actorRole: "OWNER" | "STAFF";
  linkedBy: string;
  linkedAt: string;
  idempotencyKey: string;
};

export function linkOrderCustomer(deps: LinkOrderCustomerDeps, request: LinkOrderCustomerRequest): OrderCustomerLink {
  for (const field of ["orderId", "customerId", "linkedBy"] as const) {
    if (!isNonEmptyString(request[field])) invalid(field, "must be a non-empty string");
  }
  parseUtcTimestamp("linkedAt", request.linkedAt, (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "customer.link-order",
      key: request.idempotencyKey,
      payload: { orderId: request.orderId, customerId: request.customerId, linkedBy: request.linkedBy, linkedAt: request.linkedAt },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      const customer = deps.customers.get(request.tenantId, request.customerId);
      if (!order || !customer) throw new AppError("NOT_FOUND");
      if (order.discardedAt !== undefined || order.cancelledAt !== undefined || order.closedAt !== undefined) throw new AppError("BUSINESS_INVARIANT", "a discarded, cancelled or closed order cannot be linked to a customer");
      if (customer.anonymizedAt !== undefined) throw new AppError("BUSINESS_INVARIANT", "an anonymized customer cannot be linked to an order");
      const current = deps.orderCustomerLinks.current(request.tenantId, request.orderId);
      if (current?.customerId === request.customerId) return current;
      const link: OrderCustomerLink = { id: crypto.randomUUID(), tenantId: request.tenantId, orderId: request.orderId, customerId: request.customerId, linkedBy: request.linkedBy, linkedAt: request.linkedAt };
      deps.orderCustomerLinks.save(link);
      return link;
    },
  );
}
