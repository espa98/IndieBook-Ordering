import { describe, it, expect } from "vitest";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { allocateReceipt } from "../../src/inventory/allocateReceipt";
import { receiptBalances } from "../../src/inventory/receiptBalances";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { allocationScene, deliveryScene, releaseScene } from "../helpers/inventoryFixtures";

describe("receiptBalances: 입고 기록과 배분 기록에서 버킷 잔량 산출 (BR-Q14, BR-Q17)", () => {
  it("배분하지 않으면 정상 입고량 전부가 UNALLOCATED이고, 배분하면 그만큼 ALLOCATED_OPEN으로 옮겨진다", () => {
    const { deps, request, receipt, orders } = allocationScene();
    const balancesOf = () =>
      receiptBalances(receipt, deps.receiptAllocations.list("tenant-a", receipt.id));

    expect(balancesOf()).toMatchObject({ UNALLOCATED: 4, ALLOCATED_OPEN: 0 });

    allocateReceipt(deps, request({ quantity: 2 }));
    allocateReceipt(
      deps,
      request({ orderId: orders[1]!.id, orderLineId: orders[1]!.lines[0]!.lineId, quantity: 1 }),
    );

    expect(balancesOf()).toEqual({
      UNALLOCATED: 1,
      ALLOCATED_OPEN: 3,
      DELIVERED_NET: 0,
      DISPOSITION_PENDING: 0,
      RETURN_HELD: 0,
      RETURN_DISPATCHED: 0,
      RETURNED_FINAL: 0,
      STOCK_TRANSFERRED: 0,
    });
  });

  it("배분을 해제하면 그만큼 ALLOCATED_OPEN에서 UNALLOCATED로 돌아온다", () => {
    const { deps, request, receipt, allocation } = releaseScene();
    const balancesOf = () =>
      receiptBalances(
        receipt,
        deps.receiptAllocations.list("tenant-a", receipt.id),
        deps.allocationReleases.list("tenant-a", allocation.id),
      );

    expect(balancesOf()).toMatchObject({ UNALLOCATED: 1, ALLOCATED_OPEN: 3 }); // 4권 중 3권 배분

    releaseAllocation(deps, request({ quantity: 2 }));

    expect(balancesOf()).toMatchObject({ UNALLOCATED: 3, ALLOCATED_OPEN: 1 });
  });

  it("인도하면 그만큼 ALLOCATED_OPEN에서 DELIVERED_NET으로 옮겨진다", () => {
    const { deps, request, releaseRequest, receipt, allocation } = deliveryScene();
    const balancesOf = () =>
      receiptBalances(
        receipt,
        deps.receiptAllocations.list("tenant-a", receipt.id),
        deps.allocationReleases.list("tenant-a", allocation.id),
        deps.allocationDeliveries.list("tenant-a", allocation.id),
      );

    deliverAllocation(deps, request({ quantity: 2 }));
    expect(balancesOf()).toMatchObject({ UNALLOCATED: 1, ALLOCATED_OPEN: 1, DELIVERED_NET: 2 });

    releaseAllocation(deps, releaseRequest({ quantity: 1 }));
    expect(balancesOf()).toMatchObject({ UNALLOCATED: 2, ALLOCATED_OPEN: 0, DELIVERED_NET: 2 });
  });
});
