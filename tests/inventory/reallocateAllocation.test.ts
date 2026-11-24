import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { reallocateAllocation } from "../../src/inventory/reallocateAllocation";
import { reallocationScene } from "../helpers/inventoryFixtures";

describe("reallocateAllocation: 입고 배분 재배분 (ST-R07, DEC-15, BR-Q16)", () => {
  it("Owner가 미인도 배분 일부를 다른 고객 주문 품목으로 옮기면 해제 기록과 신규 배분이 함께 남는다", () => {
    const { deps, reallocateRequest, allocation, receipt, orders } = reallocationScene();
    const allocationBefore = structuredClone(allocation);

    const result = reallocateAllocation(deps, reallocateRequest({ quantity: 1 }));

    expect(result.release).toMatchObject({
      allocationId: allocation.id,
      quantity: 1,
      reason: "고객 B가 일부 취소, 고객 A에게 우선 배분",
      releasedBy: "점주",
      releasedAt: "2026-03-04T06:58:00.000Z",
    });
    expect(result.allocation).toMatchObject({
      receiptId: receipt.id,
      orderId: orders[0]!.id,
      orderLineId: orders[0]!.lines[0]!.lineId,
      quantity: 1,
      allocatedBy: "점주",
      allocatedAt: "2026-03-04T06:58:00.000Z",
    });
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([result.release]);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(2);
    expect(deps.receiptAllocations.get("tenant-a", allocation.id)).toEqual(allocationBefore);
  });

  it("STAFF는 다른 고객 주문으로 재배분할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, reallocateRequest, allocation, receipt } = reallocationScene();

    let thrown: unknown;
    try {
      reallocateAllocation(deps, reallocateRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([]);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("신규 배분이 한도를 넘어 실패하면 해제도 기록되지 않는다(원자 처리)", () => {
    const { deps, reallocateRequest, allocation, receipt } = reallocationScene();

    let thrown: unknown;
    try {
      reallocateAllocation(deps, reallocateRequest({ quantity: 3 })); // 주문 A 연결 수량은 2
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([]);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("이미 인도한 수량은 재배분할 수 없고(BUSINESS_INVARIANT) 아무것도 기록되지 않는다", () => {
    const { deps, request, reallocateRequest, allocation, receipt } = reallocationScene();
    deliverAllocation(deps, request({ quantity: 2 })); // 3권 중 2권 인도, 미인도 1

    let thrown: unknown;
    try {
      reallocateAllocation(deps, reallocateRequest({ quantity: 2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([]);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("수량·사유·대상·담당자·actedAt이 잘못되면 VALIDATION_ERROR 400이고 아무것도 기록되지 않는다", () => {
    const { deps, reallocateRequest, allocation, receipt } = reallocationScene();
    const depsAt = { ...deps, now: () => new Date("2026-03-04T07:00:00.000Z") };

    for (const bad of [
      reallocateRequest({ quantity: 0 }),
      reallocateRequest({ quantity: 1.5 }),
      reallocateRequest({ reason: " " }),
      reallocateRequest({ toOrderId: "" }),
      reallocateRequest({ toOrderLineId: "" }),
      reallocateRequest({ actedBy: "" }),
      reallocateRequest({ actedAt: "2026-03-04" }),
      reallocateRequest({ actedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        reallocateAllocation(depsAt, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([]);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("없는 배분이거나 다른 테넌트의 배분이면 NOT_FOUND 404이다", () => {
    const { deps, reallocateRequest } = reallocationScene();

    for (const bad of [
      reallocateRequest({ allocationId: "no-such-allocation" }),
      reallocateRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        reallocateAllocation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
  });

  it("같은 멱등 키로 재호출하면 같은 결과를 돌려주고 중복 기록하지 않는다", () => {
    const { deps, reallocateRequest, allocation, receipt } = reallocationScene();

    const first = reallocateAllocation(deps, reallocateRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = reallocateAllocation(deps, reallocateRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toEqual([first.release]);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(2);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, reallocateRequest, allocation } = reallocationScene();
    reallocateAllocation(deps, reallocateRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      reallocateAllocation(deps, reallocateRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.allocationReleases.list("tenant-a", allocation.id)).toHaveLength(1);
  });
});
