import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { cancelAllocation } from "../../src/inventory/cancelAllocation";
import { cancellationScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("cancelAllocation: 주문 취소에 따른 미인도 배분 해제와 처분 대기 (ST-C01, UC-28, BR-Q21)", () => {
  it("Owner가 미인도 배분 일부를 취소하면 원 입고·주문 참조를 가진 처분 대기 기록이 남고 원 배분은 바뀌지 않는다", () => {
    const { deps, cancelRequest, allocation, orders } = cancellationScene();
    const allocationBefore = structuredClone(allocation);

    const cancellation = cancelAllocation(deps, cancelRequest({ quantity: 2 }));

    expect(cancellation).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      receiptId: allocation.receiptId,
      allocationId: allocation.id,
      orderId: orders[1]!.id,
      orderLineId: orders[1]!.lines[0]!.lineId,
      quantity: 2,
      reason: "고객 B 주문 일부 취소",
      cancelledBy: "점주",
      cancelledAt: "2026-03-04T06:52:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.allocationCancellations.list("tenant-a", allocation.id)).toEqual([cancellation]);
    expect(deps.receiptAllocations.get("tenant-a", allocation.id)).toEqual(allocationBefore);
  });

  it("취소 가능 수량은 미인도 잔량(배분-해제-인도-기취소)이고, 이미 인도한 수량은 취소할 수 없다", () => {
    const { deps, cancelRequest, request, allocateRequest, allocation } = cancellationScene(); // 배분 3
    void allocateRequest;
    releaseAllocation(deps, request({ quantity: 1 })); // 해제 1 -> 잔량 2 (request = 해제 요청)
    const cancel = (quantity: number) => {
      try {
        cancelAllocation(deps, cancelRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = cancel(3);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(cancel(1)).toBeUndefined(); // 잔량 1
    expect(cancel(2)).toBeInstanceOf(AppError);

    deliverAllocation(deps, {
      tenantId: "tenant-a",
      allocationId: allocation.id,
      quantity: 1,
      deliveredBy: "김직원",
      deliveredAt: "2026-03-04T06:55:00.000Z",
      idempotencyKey: "dlv-last",
    }); // 잔량 0
    expect(cancel(1)).toBeInstanceOf(AppError); // 인도한 수량은 취소 불가
    expect(deps.allocationCancellations.list("tenant-a", allocation.id)).toHaveLength(1);
  });

  it("STAFF는 취소 확정할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, cancelRequest, allocation } = cancellationScene();

    let thrown: unknown;
    try {
      cancelAllocation(deps, cancelRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(deps.allocationCancellations.list("tenant-a", allocation.id)).toEqual([]);
  });

  it("수량이 1 이상 정수가 아니거나 사유·담당자가 비었거나 cancelledAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, cancelRequest, allocation } = cancellationScene();

    for (const bad of [
      cancelRequest({ quantity: 0 }),
      cancelRequest({ quantity: -1 }),
      cancelRequest({ quantity: 1.5 }),
      cancelRequest({ quantity: Number.NaN }),
      cancelRequest({ reason: " " }),
      cancelRequest({ cancelledBy: "" }),
      cancelRequest({ cancelledAt: "2026-03-04" }),
      cancelRequest({ cancelledAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        cancelAllocation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.allocationCancellations.list("tenant-a", allocation.id)).toEqual([]);
  });

  it("없는 배분이거나 다른 테넌트의 배분이면 NOT_FOUND 404이다", () => {
    const { deps, cancelRequest, allocation } = cancellationScene();

    for (const bad of [
      cancelRequest({ allocationId: "no-such-allocation" }),
      cancelRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        cancelAllocation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.allocationCancellations.list("tenant-a", allocation.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 처분 대기 기록을 돌려주고 중복 취소하지 않는다", () => {
    const { deps, cancelRequest, allocation } = cancellationScene();

    const first = cancelAllocation(deps, cancelRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = cancelAllocation(deps, cancelRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.allocationCancellations.list("tenant-a", allocation.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, cancelRequest, allocation } = cancellationScene();
    cancelAllocation(deps, cancelRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      cancelAllocation(deps, cancelRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.allocationCancellations.list("tenant-a", allocation.id)).toHaveLength(1);
  });
});
