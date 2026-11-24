import type {
  OrderCancellationDecision,
  OrderCancellationRequest,
} from "../../src/order/requestOrderCancellation";

export function createInMemoryOrderCancellationRequestRepository() {
  const all: OrderCancellationRequest[] = [];
  return {
    get(tenantId: string, id: string): OrderCancellationRequest | undefined {
      return all.find((r) => r.tenantId === tenantId && r.id === id);
    },
    list(tenantId: string, orderId: string): OrderCancellationRequest[] {
      return all.filter((r) => r.tenantId === tenantId && r.orderId === orderId);
    },
    save(request: OrderCancellationRequest): void {
      all.push(request);
    },
  };
}

export function createInMemoryOrderCancellationDecisionRepository() {
  const all: OrderCancellationDecision[] = [];
  return {
    list(tenantId: string, requestId: string): OrderCancellationDecision[] {
      return all.filter((d) => d.tenantId === tenantId && d.requestId === requestId);
    },
    save(decision: OrderCancellationDecision): void {
      all.push(decision);
    },
  };
}
