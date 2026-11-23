import { addOrderLine } from "../../src/order/addOrderLine";
import { confirmOrder } from "../../src/order/confirmOrder";
import {
  createDraftOrder,
  type NewOrderLine,
  type Order,
} from "../../src/order/createDraftOrder";
import type {
  Supplier,
  SourcingAllocation,
} from "../../src/procurement/allocateSourcing";

/** 지정한 품목을 가진 확정 주문을 만든다 (표시번호는 고정). */
export function confirmedOrder(tenantId: string, lines: NewOrderLine[]): Order {
  const draft = lines.reduce(addOrderLine, createDraftOrder({ tenantId }));
  return confirmOrder(draft, { expectedVersion: 1, issueDisplayNumber: () => 1 });
}

export function createInMemorySupplierRepository(initial: Supplier[] = []) {
  const suppliers = new Map<string, Supplier>();
  for (const s of initial) suppliers.set(`${s.tenantId}:${s.code}`, s);
  return {
    get(tenantId: string, code: string): Supplier | undefined {
      return suppliers.get(`${tenantId}:${code}`);
    },
  };
}

export function createInMemoryAllocationRepository(
  initial: SourcingAllocation[] = [],
) {
  const all = new Map<string, SourcingAllocation>();
  for (const a of initial) all.set(`${a.tenantId}:${a.id}`, a);
  return {
    get(tenantId: string, id: string): SourcingAllocation | undefined {
      return all.get(`${tenantId}:${id}`);
    },
    list(tenantId: string): SourcingAllocation[] {
      return [...all.values()].filter((a) => a.tenantId === tenantId);
    },
    save(allocation: SourcingAllocation): void {
      all.set(`${allocation.tenantId}:${allocation.id}`, allocation);
    },
  };
}
