import { describe, it, expect } from "vitest";
import { receiveGoods } from "../../src/inventory/receiveGoods";
import { releaseSourcing } from "../../src/procurement/releaseSourcing";
import type { SourcingRelease } from "../../src/procurement/releaseSourcing";
import { openSupplierObligations } from "../../src/procurement/supplierObligations";
import { receivingScene } from "../helpers/inventoryFixtures";

/** 6권 발주(주문 2/3/1권)가 SENT이고, 첫 주문(2권)의 배정이 해제된 세계 */
function releasedScene() {
  const s = receivingScene();
  const saved: SourcingRelease[] = [];
  const sourcingReleases = {
    list: (_t: string, allocationId: string) => saved.filter((r) => r.allocationId === allocationId),
    listByOrder: (t: string, orderId: string) => saved.filter((r) => r.tenantId === t && r.orderId === orderId),
    save: (r: SourcingRelease) => void saved.push(r),
  };
  const deps = { ...s.deps, allocations: s.w.deps.allocations, sourcingReleases };
  const release = releaseSourcing(deps, {
    tenantId: "tenant-a",
    allocationId: s.allocations[0]!.id,
    reason: "고객 취소",
    releasedBy: "김직원",
    releasedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: "rel-ob",
  });
  return { ...s, deps, release, sourcingReleases };
}

describe("openSupplierObligations: 배정 해제 뒤 남는 공급처 외부 의무 (BR-P05)", () => {
  it("전달된 발주에 연결됐던 배정을 해제하면 그 발주 품목의 미입고 잔량 안에서 열린 의무가 파생되고, 입고로 잔량이 줄면 의무도 줄어든다", () => {
    const { deps, orders, sent, poLineId } = releasedScene();

    expect(openSupplierObligations(deps, "tenant-a", orders[0]!.id)).toEqual([
      {
        purchaseOrderId: sent.id,
        poLineId,
        supplierCode: "sup-a",
        retainedQuantity: 2,
        openQuantity: 2, // 발주 잔량 6권, 입고 전
      },
    ]);
    expect(openSupplierObligations(deps, "tenant-a", orders[1]!.id)).toEqual([]); // 해제하지 않은 주문

    receiveGoods(deps, {
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId,
      normalQuantity: 5, // 잔량 1권
      damagedQuantity: 0,
      misdeliveredQuantity: 0,
      inspectedBy: "김검수",
      receivedAt: "2026-03-04T06:30:00.000Z",
      idempotencyKey: "recv-ob",
    });
    expect(openSupplierObligations(deps, "tenant-a", orders[0]!.id)[0]).toMatchObject({
      retainedQuantity: 2,
      openQuantity: 1,
    });
  });
});
