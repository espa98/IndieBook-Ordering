import { describe, it, expect } from "vitest";
import { evaluateOrderClosure } from "../../src/order/evaluateOrderClosure";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { markPurchaseOrderReady } from "../../src/procurement/markPurchaseOrderReady";
import { recordPurchaseOrderDelivery } from "../../src/procurement/recordPurchaseOrderDelivery";
import { releaseSourcing } from "../../src/procurement/releaseSourcing";
import type { SourcingRelease } from "../../src/procurement/releaseSourcing";
import { createInMemoryExportRepository } from "../helpers/procurementFixtures";
import { closureScene } from "../helpers/closureFixtures";

/**
 * 주문 D(2권)가 결제 확인·전량 인도까지 끝났고, 이 주문이 공급처 sup-a에 2권을 발주(SENT)했다가
 * 배정을 해제한 세계. 종결 조건 중 공급처 의무만 남아 있다.
 */
function releasedObligationScene() {
  const s = closureScene();
  s.pay(s.orderD.id, "30000");
  postFulfillment(
    s.deps,
    s.fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: s.reservation.id, quantity: 2 }] }),
  );
  const allocation = s.w.allocate(s.orderD, 0, 2);
  const draft = createPurchaseOrder(s.w.deps, s.w.request([allocation.id]));
  const ready = markPurchaseOrderReady(s.w.deps, {
    tenantId: "tenant-a",
    purchaseOrderId: draft.id,
    expectedVersion: draft.version,
    idempotencyKey: "ready-obl",
  });
  const sent = recordPurchaseOrderDelivery(
    {
      purchaseOrders: s.w.deps.purchaseOrders,
      exports: createInMemoryExportRepository(),
      idempotency: s.w.deps.idempotency,
      now: () => new Date("2026-03-04T06:00:00.000Z"),
    },
    {
      tenantId: "tenant-a",
      purchaseOrderId: ready.id,
      expectedVersion: ready.version,
      method: "EMAIL",
      deliveredAt: "2026-03-04T05:06:07.000Z",
      deliveredBy: "홍길동",
      idempotencyKey: "send-obl",
    },
  );
  const saved: SourcingRelease[] = [];
  const sourcingReleases = {
    list: (_t: string, allocationId: string) => saved.filter((r) => r.allocationId === allocationId),
    listByOrder: (t: string, orderId: string) => saved.filter((r) => r.tenantId === t && r.orderId === orderId),
    save: (r: SourcingRelease) => void saved.push(r),
  };
  const deps = { ...s.deps, sourcingReleases, supplierObligations: { ...s.deps, sourcingReleases } };
  const release = () =>
    releaseSourcing(
      { ...s.deps, allocations: s.w.deps.allocations, sourcingReleases, now: () => new Date("2026-03-04T07:00:00.000Z") },
      {
        tenantId: "tenant-a",
        allocationId: allocation.id,
        reason: "고객 취소",
        releasedBy: "김직원",
        releasedAt: "2026-03-04T06:50:00.000Z",
        idempotencyKey: "rel-obl",
      },
    );
  return { ...s, deps, sent, release, allocation };
}

describe("공급처 외부 의무에 의한 주문 종결 차단 (BR-P05, BR-O01)", () => {
  it("배정을 풀었지만 공급처 발주 의무가 남은 주문은 종결할 수 없고(EXTERNAL_OBLIGATION_OPEN), 의무가 입고로 해소되면 종결 가능해진다", () => {
    const { deps, release, orderD, sent } = releasedObligationScene();
    release();
    const order = deps.orders.get("tenant-a", orderD.id)!;

    expect(evaluateOrderClosure(deps, "tenant-a", order)).toEqual({
      closable: false,
      blockers: ["EXTERNAL_OBLIGATION_OPEN"],
    });

    // 공급처가 발주 전량을 입고하면 의무가 사라진다
    deps.receipts.save({
      id: "rcpt-obl",
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId: sent.lines[0]!.poLineId,
      normalQuantity: 2,
      excessQuantity: 0,
      damagedQuantity: 0,
      misdeliveredQuantity: 0,
      inspectedBy: "김검수",
      receivedAt: "2026-03-04T06:30:00.000Z",
      recordedAt: "2026-03-04T06:30:00.000Z",
    });
    expect(evaluateOrderClosure(deps, "tenant-a", order)).toEqual({ closable: true, blockers: [] });
  });
});
