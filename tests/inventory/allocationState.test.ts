import { describe, it, expect } from "vitest";
import { allocationState } from "../../src/inventory/allocationState";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { deliveryScene, releaseScene } from "../helpers/inventoryFixtures";

describe("allocationState: 배분 잔량·상태 파생 (BR-Q16)", () => {
  it("잔량 B=생성량-해제량이 0보다 크면 OPEN, 0이면 CLOSED이다", () => {
    const { deps, request, allocation } = releaseScene();
    const stateOf = () =>
      allocationState(allocation, deps.allocationReleases.list("tenant-a", allocation.id));

    expect(stateOf()).toEqual({ generated: 3, released: 0, remaining: 3, status: "OPEN" });

    releaseAllocation(deps, request({ quantity: 2 }));
    expect(stateOf()).toEqual({ generated: 3, released: 2, remaining: 1, status: "OPEN" });

    releaseAllocation(deps, request({ quantity: 1 }));
    expect(stateOf()).toEqual({ generated: 3, released: 3, remaining: 0, status: "CLOSED" });
  });

  it("인도한 양도 잔량에서 빠지고, 해제와 인도로 잔량이 0이 되면 CLOSED이다", () => {
    const { deps, request, releaseRequest, allocation } = deliveryScene();
    const stateOf = () =>
      allocationState(
        allocation,
        deps.allocationReleases.list("tenant-a", allocation.id),
        deps.allocationDeliveries.list("tenant-a", allocation.id),
      );

    deliverAllocation(deps, request({ quantity: 2 }));
    expect(stateOf()).toMatchObject({ remaining: 1, status: "OPEN" });

    releaseAllocation(deps, releaseRequest({ quantity: 1 }));
    expect(stateOf()).toEqual({ generated: 3, released: 1, remaining: 0, status: "CLOSED" });
  });
});
