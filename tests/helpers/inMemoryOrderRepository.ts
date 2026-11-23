import type { Order } from "../../src/order/createDraftOrder";

export function createInMemoryOrderRepository(initial: Order[] = []) {
  const orders = new Map<string, Order>();
  for (const o of initial) orders.set(`${o.tenantId}:${o.id}`, o);

  return {
    get(tenantId: string, orderId: string): Order | undefined {
      return orders.get(`${tenantId}:${orderId}`);
    },
    save(order: Order): void {
      orders.set(`${order.tenantId}:${order.id}`, order);
    },
  };
}
