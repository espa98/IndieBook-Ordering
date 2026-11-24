import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { deliveryScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("deliverAllocation: 입고 배분 인도 (ST-R06, UC-13, BR-Q16)", () => {
  it("배분 일부를 인도하면 주문 품목을 가리키는 수령 거래가 남고 원 배분 기록은 바뀌지 않는다", () => {
    const { deps, request, allocation, orders } = deliveryScene();
    const allocationBefore = structuredClone(allocation);

    const delivery = deliverAllocation(deps, request({ quantity: 1 }));

    expect(delivery).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      allocationId: allocation.id,
      receiptId: allocation.receiptId,
      orderId: orders[1]!.id,
      orderLineId: orders[1]!.lines[0]!.lineId,
      quantity: 1,
      deliveredBy: "김직원",
      deliveredAt: "2026-03-04T06:55:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.allocationDeliveries.list("tenant-a", allocation.id)).toEqual([delivery]);
    expect(deps.receiptAllocations.get("tenant-a", allocation.id)).toEqual(allocationBefore);
  });

  it("인도 합계가 잔량(배분-해제-기인도)을 넘으면 BUSINESS_INVARIANT 422이다", () => {
    const { deps, request, releaseRequest, allocation } = deliveryScene();
    const deliver = (quantity: number) => {
      try {
        deliverAllocation(deps, request({ quantity }));
      } catch (error) {
        return error;
      }
    };

    releaseAllocation(deps, releaseRequest({ quantity: 1 })); // 배분 3 중 1 해제 -> 잔량 2
    const tooMany = deliver(3);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(deliver(1)).toBeUndefined(); // 잔량 1
    expect(deliver(2)).toBeInstanceOf(AppError); // 1 초과
    expect(deliver(1)).toBeUndefined(); // 잔량 0
    expect(deliver(1)).toBeInstanceOf(AppError);
    expect(
      deps.allocationDeliveries.list("tenant-a", allocation.id).map((d) => d.quantity),
    ).toEqual([1, 1]);
  });

  it("수량이 1 이상 정수가 아니거나 담당자가 비었거나 deliveredAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, request, allocation } = deliveryScene();
    const depsAt = { ...deps, now: () => new Date("2026-03-04T07:00:00.000Z") };

    for (const bad of [
      request({ quantity: 0 }),
      request({ quantity: -1 }),
      request({ quantity: 1.5 }),
      request({ quantity: Number.NaN }),
      request({ deliveredBy: " " }),
      request({ deliveredAt: "2026-03-04" }),
      request({ deliveredAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        deliverAllocation(depsAt, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.allocationDeliveries.list("tenant-a", allocation.id)).toEqual([]);
  });

  it("없는 배분이거나 다른 테넌트의 배분이면 NOT_FOUND 404이다", () => {
    const { deps, request, allocation } = deliveryScene();

    for (const bad of [
      request({ allocationId: "no-such-allocation" }),
      request({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        deliverAllocation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.allocationDeliveries.list("tenant-a", allocation.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 인도를 돌려주고 중복 기록하지 않는다", () => {
    const { deps, request, allocation } = deliveryScene();

    const first = deliverAllocation(deps, request({ quantity: 1, idempotencyKey: "k" }));
    const replay = deliverAllocation(deps, request({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.allocationDeliveries.list("tenant-a", allocation.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, request, allocation } = deliveryScene();
    deliverAllocation(deps, request({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      deliverAllocation(deps, request({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.allocationDeliveries.list("tenant-a", allocation.id)).toHaveLength(1);
  });
});
