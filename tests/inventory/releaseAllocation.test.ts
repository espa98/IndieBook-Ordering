import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { cancelAllocation } from "../../src/inventory/cancelAllocation";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { deliveryScene, releaseScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("releaseAllocation: 입고 배분 해제 (ST-R05, BR-Q16)", () => {
  it("배분 일부를 해제하면 별도 해제 기록이 남고 원 배분 기록은 바뀌지 않는다", () => {
    const { deps, request, allocation } = releaseScene();
    const allocationBefore = structuredClone(allocation);

    const release = releaseAllocation(deps, request({ quantity: 1 }));

    expect(release).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      allocationId: allocation.id,
      quantity: 1,
      reason: "고객이 다른 도서로 변경 요청",
      releasedBy: "김직원",
      releasedAt: "2026-03-04T06:50:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([release]);
    expect(deps.receiptAllocations.get("tenant-a", allocation.id)).toEqual(allocationBefore);
  });

  it("해제 합계가 배분 수량(3)을 넘으면 BUSINESS_INVARIANT 422이고, 기존 해제를 합산한다", () => {
    const { deps, request, allocation } = releaseScene();
    const release = (quantity: number) => {
      try {
        releaseAllocation(deps, request({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = release(4);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(release(2)).toBeUndefined(); // 잔량 1
    expect(release(2)).toBeInstanceOf(AppError); // 1 초과
    expect(release(1)).toBeUndefined(); // 잔량 0 (CLOSED)
    expect(release(1)).toBeInstanceOf(AppError); // 더 풀 것이 없다
    expect(
      deps.allocationReleases.list("tenant-a", allocation.id).map((r) => r.quantity),
    ).toEqual([2, 1]);
  });

  it("수량이 1 이상 정수가 아니거나 필수 문자열이 비었거나 releasedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, request, allocation } = releaseScene();
    const depsAt = { ...deps, now: () => new Date("2026-03-04T07:00:00.000Z") };

    for (const bad of [
      request({ quantity: 0 }),
      request({ quantity: -1 }),
      request({ quantity: 1.5 }),
      request({ quantity: Number.NaN }),
      request({ reason: " " }),
      request({ releasedBy: "" }),
      request({ releasedAt: "2026-03-04" }),
      request({ releasedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        releaseAllocation(depsAt, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([]);
  });

  it("없는 배분이거나 다른 테넌트의 배분이면 NOT_FOUND 404이다", () => {
    const { deps, request, allocation } = releaseScene();

    for (const bad of [
      request({ allocationId: "no-such-allocation" }),
      request({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        releaseAllocation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 해제를 돌려주고 중복 기록하지 않는다", () => {
    const { deps, request, allocation } = releaseScene();

    const first = releaseAllocation(deps, request({ quantity: 1, idempotencyKey: "k" }));
    const replay = releaseAllocation(deps, request({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, request, allocation } = releaseScene();
    releaseAllocation(deps, request({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      releaseAllocation(deps, request({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toHaveLength(1);
  });

  it("이미 인도한 수량은 해제할 수 없고 미인도 잔량만 해제할 수 있다", () => {
    const { deps, request, releaseRequest } = deliveryScene();
    deliverAllocation(deps, request({ quantity: 2 })); // 배분 3 중 2 인도 -> 미인도 1

    let thrown: unknown;
    try {
      releaseAllocation(deps, releaseRequest({ quantity: 2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(releaseAllocation(deps, releaseRequest({ quantity: 1 })).quantity).toBe(1);
  });

  it("주문 취소로 처분 대기가 된 수량은 일반 해제(UNALLOCATED 복귀)할 수 없다", () => {
    const { deps, request, allocation } = releaseScene(); // 배분 3
    cancelAllocation(deps, {
      tenantId: "tenant-a",
      allocationId: allocation.id,
      quantity: 2,
      reason: "고객 주문 일부 취소",
      actorRole: "OWNER",
      cancelledBy: "점주",
      cancelledAt: "2026-03-04T06:52:00.000Z",
      idempotencyKey: "can-1",
    }); // 잔량 1

    let thrown: unknown;
    try {
      releaseAllocation(deps, request({ quantity: 2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(releaseAllocation(deps, request({ quantity: 1 })).quantity).toBe(1);
  });
});
