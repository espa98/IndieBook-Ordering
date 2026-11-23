import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { markPurchaseOrderReady } from "../../src/procurement/markPurchaseOrderReady";
import { recordPurchaseOrderDelivery } from "../../src/procurement/recordPurchaseOrderDelivery";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type { NewOrderLine } from "../../src/order/createDraftOrder";
import { createInMemoryOrderRepository } from "./inMemoryOrderRepository";
import {
  confirmedOrder,
  createInMemoryAllocationRepository,
  createInMemoryExportRepository,
  createInMemoryPurchaseOrderRepository,
  createInMemoryReplyRepository,
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

/**
 * 전달 완료(SENT) 발주 1개가 있는 세계 (회신·취소 요청 테스트 공용).
 * 고객 3명이 같은 도서를 2+3+1권 주문했고, 합산된 발주 품목은 6권이다 (PO-003).
 */
export function sentScene(options: { secondBook?: boolean } = {}) {
  const w = world();
  const orders = [2, 3, 1].map((qty) =>
    w.addOrder([{ bookId: "book-1", quantity: qty, unitPriceKrw: "15000" }]),
  );
  const allocations = orders.map((o, i) => w.allocate(o, 0, [2, 3, 1][i]!));
  if (options.secondBook) {
    // 다품목 검증용: 다른 도서(book-2) 5권이 같은 발주에 별도 품목으로 들어간다
    const other = w.addOrder([{ bookId: "book-2", quantity: 5, unitPriceKrw: "9000" }]);
    orders.push(other);
    allocations.push(w.allocate(other, 0, 5));
  }
  const draft = createPurchaseOrder(w.deps, w.request(allocations.map((a) => a.id)));
  const ready = markPurchaseOrderReady(w.deps, {
    tenantId: "tenant-a",
    purchaseOrderId: draft.id,
    expectedVersion: 1,
    idempotencyKey: "ready-1",
  });
  const exports = createInMemoryExportRepository();
  const replies = createInMemoryReplyRepository();
  const NOW = "2026-03-04T06:00:00.000Z";
  const sent = recordPurchaseOrderDelivery(
    { purchaseOrders: w.deps.purchaseOrders, exports, idempotency: w.deps.idempotency, now: () => new Date(NOW) },
    {
      tenantId: "tenant-a",
      purchaseOrderId: ready.id,
      expectedVersion: 2,
      method: "EMAIL",
      deliveredAt: "2026-03-04T05:06:07.000Z",
      deliveredBy: "홍길동",
      idempotencyKey: "send-1",
    },
  );
  return {
    w,
    sent,
    orders,
    allocations,
    /** 회신·취소 요청 함수에 넘길 의존성 */
    deps: {
      purchaseOrders: w.deps.purchaseOrders,
      replies,
      idempotency: w.deps.idempotency,
      now: () => new Date("2026-03-04T07:00:00.000Z"),
    },
    poLineId: sent.lines[0]!.poLineId, // book-1: 6권
    /** 두 번째 도서가 있으면 그 발주 품목 ID (book-2: 5권) */
    secondPoLineId: sent.lines[1]?.poLineId,
  };
}
