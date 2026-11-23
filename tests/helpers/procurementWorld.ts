import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type { NewOrderLine } from "../../src/order/createDraftOrder";
import { createInMemoryOrderRepository } from "./inMemoryOrderRepository";
import {
  confirmedOrder,
  createInMemoryAllocationRepository,
  createInMemoryPurchaseOrderRepository,
  createInMemorySupplierRepository,
} from "./procurementFixtures";

/** 주문·공급처·배정을 쉽게 만드는 테스트용 세계 (조달·발주 테스트 공용) */
export function world(tenantId = "tenant-a") {
  const orders = createInMemoryOrderRepository();
  const suppliers = createInMemorySupplierRepository([
    { tenantId, code: "sup-a", active: true },
    { tenantId, code: "sup-b", active: true },
  ]);
  const allocations = createInMemoryAllocationRepository();
  const purchaseOrders = createInMemoryPurchaseOrderRepository();
  const deps = {
    orders,
    suppliers,
    allocations,
    purchaseOrders,
    idempotency: createIdempotencyStore(),
  };
  let n = 0;
  return {
    deps,
    /** 확정 주문을 만들어 저장한다 */
    addOrder(lines: NewOrderLine[]) {
      const order = confirmedOrder(tenantId, lines);
      orders.save(order);
      return order;
    },
    /** 주문 품목(index)에 공급처 배정을 만든다 */
    allocate(
      order: ReturnType<typeof confirmedOrder>,
      lineIndex: number,
      quantity: number,
      supplierCode = "sup-a",
    ) {
      return allocateSourcing(deps, {
        tenantId,
        orderId: order.id,
        lineId: order.lines[lineIndex]!.lineId,
        supplierCode,
        quantity,
        idempotencyKey: `alloc-${++n}`,
      });
    },
    request(allocationIds: string[], extra: Record<string, unknown> = {}) {
      return {
        tenantId,
        supplierCode: "sup-a",
        allocationIds,
        idempotencyKey: `po-${++n}`,
        ...extra,
      };
    },
  };
}
