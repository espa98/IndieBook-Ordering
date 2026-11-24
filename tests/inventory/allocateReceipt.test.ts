import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { allocateReceipt } from "../../src/inventory/allocateReceipt";
import { receiveGoods } from "../../src/inventory/receiveGoods";
import { correctReceipt } from "../../src/inventory/correctReceipt";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { allocationScene, correctionScene, deliveryScene, releaseScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("allocateReceipt: 입고 수량의 고객별 배분 (ST-R04, UC-11, BR-Q13/Q14)", () => {
  it("입고 정상량을 같은 발주 품목에 연결된 주문 품목에 배분하면 배분 기록이 남고 입고 기록은 바뀌지 않는다", () => {
    const { deps, request, receipt, orders } = allocationScene();
    const receiptBefore = structuredClone(receipt);

    const allocation = allocateReceipt(deps, request());

    expect(allocation).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      receiptId: receipt.id,
      orderId: orders[0]!.id,
      orderLineId: orders[0]!.lines[0]!.lineId,
      quantity: 2,
      allocatedBy: "김직원",
      allocatedAt: "2026-03-04T06:40:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toEqual([allocation]);
    expect(deps.receipts.get("tenant-a", receipt.id)).toEqual(receiptBefore);
  });

  it("이 입고의 발주 품목에 연결되지 않은 주문 품목에는 배분할 수 없다(BUSINESS_INVARIANT 422)", () => {
    const { deps, request, receipt, w } = allocationScene();
    const stranger = w.addOrder([
      { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" },
    ]);

    let thrown: unknown;
    try {
      allocateReceipt(
        deps,
        request({ orderId: stranger.id, orderLineId: stranger.lines[0]!.lineId, quantity: 1 }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).httpStatus).toBe(422);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("배분 합계가 입고 정상량(4)을 넘으면 BUSINESS_INVARIANT 422이고, 기존 배분을 합산한다", () => {
    const { deps, request, receipt, orders } = allocationScene();
    const to = (i: number, quantity: number) => {
      try {
        allocateReceipt(
          deps,
          request({ orderId: orders[i]!.id, orderLineId: orders[i]!.lines[0]!.lineId, quantity }),
        );
      } catch (error) {
        return error;
      }
    };

    expect(to(0, 2)).toBeUndefined(); // 2/4
    const tooMany = to(1, 3); // 5 > 4
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(to(1, 2)).toBeUndefined(); // 4/4
    expect(to(2, 1)).toBeInstanceOf(AppError); // 남은 입고량 0
    expect(
      deps.receiptAllocations.list("tenant-a", receipt.id).map((a) => a.quantity),
    ).toEqual([2, 2]);
  });

  it("주문 품목별 배분 합계가 발주 연결 수량(2)을 넘으면 입고량이 남아 있어도 BUSINESS_INVARIANT 422이다", () => {
    const { deps, request, receipt } = allocationScene();
    const to = (quantity: number) => {
      try {
        allocateReceipt(deps, request({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const over = to(3); // 입고 4 이내지만 연결 수량 2 초과
    expect(over).toBeInstanceOf(AppError);
    expect((over as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(to(1)).toBeUndefined(); // 1/2
    expect(to(2)).toBeInstanceOf(AppError); // 1+2 > 2
    expect(to(1)).toBeUndefined(); // 2/2
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(2);
  });

  it("같은 발주 품목의 다른 입고에서 이미 배분한 양도 주문 품목 한도(2)에 합산한다", () => {
    const { deps, request, receipt, receiptAllocations, sent, poLineId } = allocationScene();
    const second = receiveGoods(deps, {
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId,
      normalQuantity: 2,
      damagedQuantity: 0,
      misdeliveredQuantity: 0,
      inspectedBy: "김검수",
      receivedAt: "2026-03-04T06:35:00.000Z",
      idempotencyKey: "recv-2",
    });

    allocateReceipt(deps, request({ quantity: 2 })); // 첫 입고에서 한도 소진

    let thrown: unknown;
    try {
      allocateReceipt(deps, request({ receiptId: second.id, quantity: 1 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(receiptAllocations.list("tenant-a", second.id)).toEqual([]);
    expect(receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("배분 수량이 1 이상의 정수가 아니면 VALIDATION_ERROR 400이다", () => {
    const { deps, request, receipt } = allocationScene();

    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        allocateReceipt(deps, request({ quantity }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("필수 문자열이 비었거나 allocatedAt이 RFC3339 UTC가 아니거나 미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, request, receipt } = allocationScene();
    const depsAt = { ...deps, now: () => new Date("2026-03-04T07:00:00.000Z") };

    for (const bad of [
      request({ allocatedBy: " " }),
      request({ orderId: "" }),
      request({ orderLineId: "" }),
      request({ allocatedAt: "2026-03-04" }),
      request({ allocatedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        allocateReceipt(depsAt, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("없는 입고이거나 다른 테넌트의 입고면 NOT_FOUND 404이다", () => {
    const { deps, request, receipt } = allocationScene();

    for (const bad of [
      request({ receiptId: "no-such-receipt" }),
      request({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        allocateReceipt(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 배분을 돌려주고 중복 기록하지 않는다", () => {
    const { deps, request, receipt } = allocationScene();

    const first = allocateReceipt(deps, request({ quantity: 1, idempotencyKey: "k" }));
    const replay = allocateReceipt(deps, request({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, request, receipt } = allocationScene();
    allocateReceipt(deps, request({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      allocateReceipt(deps, request({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("배분을 해제하면 해제한 만큼 입고량과 주문 품목 한도가 다시 열려 재배분할 수 있다", () => {
    const { deps, request, allocateRequest, receipt, orders } = releaseScene();
    const toB = (quantity: number) => {
      try {
        allocateReceipt(
          deps,
          allocateRequest({ orderId: orders[1]!.id, orderLineId: orders[1]!.lines[0]!.lineId, quantity }),
        );
      } catch (error) {
        return error;
      }
    };
    allocateReceipt(deps, allocateRequest({ quantity: 1 })); // 주문 A 1권: 입고 4권 모두 배분됨 (A1 + B3)
    expect(toB(1)).toBeInstanceOf(AppError); // 입고량 소진

    releaseAllocation(deps, request({ quantity: 2 }));

    expect(toB(2)).toBeUndefined(); // 순배분 B 1 -> 3, 입고 순배분 2 -> 4
    expect(toB(1)).toBeInstanceOf(AppError); // B의 연결 수량 3 소진
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(3);
  });

  it("인도한 수량은 해제와 달리 한도를 다시 열지 않는다(순인도도 배분 누적에 포함)", () => {
    const { deps, request, allocateRequest, receipt, orders } = deliveryScene();
    deliverAllocation(deps, request({ quantity: 3 })); // 주문 B 연결 수량 3을 모두 인도

    let thrown: unknown;
    try {
      allocateReceipt(
        deps,
        allocateRequest({ orderId: orders[1]!.id, orderLineId: orders[1]!.lines[0]!.lineId, quantity: 1 }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("입고 정정으로 줄어든 정상 순량(3)이 배분 한도가 된다", () => {
    const { deps, correctRequest, allocateRequest, receipt, orders } = correctionScene();
    correctReceipt(deps, correctRequest({ quantity: 1 })); // 정상 4 -> 순량 3
    const to = (i: number, quantity: number) => {
      try {
        allocateReceipt(
          deps,
          allocateRequest({ orderId: orders[i]!.id, orderLineId: orders[i]!.lines[0]!.lineId, quantity }),
        );
      } catch (error) {
        return error;
      }
    };

    expect(to(1, 3)).toBeUndefined(); // 3/3
    const over = to(0, 1); // 총 4 > 순량 3
    expect(over).toBeInstanceOf(AppError);
    expect((over as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.receiptAllocations.list("tenant-a", receipt.id)).toHaveLength(1);
  });
});
