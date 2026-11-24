import { describe, it, expect } from "vitest";
import { allocationState } from "../../src/inventory/allocationState";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { releaseScene } from "../helpers/inventoryFixtures";

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
});
