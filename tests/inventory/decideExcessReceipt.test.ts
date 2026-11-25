import { describe, it, expect } from "vitest";
import { decideExcessReceipt } from "../../src/inventory/decideExcessReceipt";
import { AppError } from "../../src/errors/AppError";
import { excessScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("decideExcessReceipt: 초과입고 Owner 승인·거절 (ST-R02, D30)", () => {
  it("Owner가 초과 일부를 승인하면 별도 결정 기록이 남고, 입고 기록과 발주는 바뀌지 않는다", () => {
    const { deps, request, receipt, sent } = excessScene();
    const receiptBefore = structuredClone(receipt);
    const poBefore = structuredClone(deps.purchaseOrders.get("tenant-a", sent.id));

    const decision = decideExcessReceipt(deps, request({ quantity: 1 }));

    expect(decision).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      receiptId: receipt.id,
      decision: "APPROVED",
      quantity: 1,
      reason: "공급처 사과 증정분, 점주 승인",
      decidedBy: "점주",
      decidedAt: "2026-03-04T06:45:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([decision]);
    expect(deps.receipts.get("tenant-a", receipt.id)).toEqual(receiptBefore); // 입고 원본 보존
    expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(poBefore); // 발주 원본 자동 증가 금지 (D30)
  });

  it("Owner가 초과분을 거절하면 REJECTED 결정이 기록되고 입고 기록은 바뀌지 않는다", () => {
    const { deps, request, receipt } = excessScene();
    const receiptBefore = structuredClone(receipt);

    const decision = decideExcessReceipt(
      deps,
      request({ decision: "REJECTED", quantity: 2, reason: "주문하지 않은 물량, 반품" }),
    );

    expect(decision).toMatchObject({
      receiptId: receipt.id,
      decision: "REJECTED",
      quantity: 2,
      reason: "주문하지 않은 물량, 반품",
    });
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([decision]);
    expect(deps.receipts.get("tenant-a", receipt.id)).toEqual(receiptBefore);
  });

  it("사유가 비어 있으면 VALIDATION_ERROR 400이고 아무것도 기록되지 않는다", () => {
    const { deps, request, receipt } = excessScene();

    let thrown: unknown;
    try {
      decideExcessReceipt(deps, request({ reason: "  " }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    expect((thrown as AppError).httpStatus).toBe(400);
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("없는 입고이거나 다른 테넌트의 입고면 NOT_FOUND 404이다", () => {
    const { deps, request, receipt } = excessScene();

    for (const bad of [
      request({ receiptId: "no-such-receipt" }),
      request({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        decideExcessReceipt(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("결정 수량이 입고의 초과 수량(2)을 넘으면 BUSINESS_INVARIANT 422이고, 기존 결정도 합산한다", () => {
    const { deps, request, receipt } = excessScene();

    const attempt = (quantity: number) => {
      try {
        decideExcessReceipt(deps, request({ quantity, idempotencyKey: `exc-${quantity}-${Math.random()}` }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = attempt(3);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);

    expect(attempt(1)).toBeUndefined(); // 2 중 1 결정
    expect(attempt(2)).toBeInstanceOf(AppError); // 남은 1을 넘는다
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toHaveLength(1);
    expect(attempt(1)).toBeUndefined(); // 남은 1은 결정 가능
  });

  it("결정 수량이 1 이상의 정수가 아니면 VALIDATION_ERROR 400이다", () => {
    const { deps, request, receipt } = excessScene();

    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        decideExcessReceipt(deps, request({ quantity }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("결정이 APPROVED·REJECTED가 아니면(없는 값·빈 문자열·숫자·null·누락) VALIDATION_ERROR 400이고 아무것도 기록되지 않는다", () => {
    const { deps, request, receipt } = excessScene();

    for (const decision of ["BOGUS", "", 123, null, undefined]) {
      let thrown: unknown;
      try {
        decideExcessReceipt(deps, request({ decision } as never));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(decision)).toBeInstanceOf(AppError);
      expect((thrown as AppError).code, JSON.stringify(decision)).toBe("VALIDATION_ERROR");
    }
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("결정 시각이 RFC3339 UTC 시각이 아니거나(빈 문자열·숫자·null·누락·날짜만) 미래이면 VALIDATION_ERROR 400이고 아무것도 기록되지 않는다", () => {
    const { deps, request, receipt } = excessScene();

    for (const decidedAt of ["", 123, null, undefined, "not-a-date", "2026-03-04", "2999-01-01T00:00:00.000Z"]) {
      let thrown: unknown;
      try {
        decideExcessReceipt(deps, request({ decidedAt } as never));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(decidedAt)).toBeInstanceOf(AppError);
      expect((thrown as AppError).code, JSON.stringify(decidedAt)).toBe("VALIDATION_ERROR");
    }
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 결정을 돌려주고 중복 기록하지 않는다", () => {
    const { deps, request, receipt } = excessScene();

    const first = decideExcessReceipt(deps, request({ quantity: 1 }));
    const replay = decideExcessReceipt(deps, request({ quantity: 1 }));

    expect(replay).toEqual(first);
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, request } = excessScene();
    decideExcessReceipt(deps, request({ quantity: 1 }));

    let thrown: unknown;
    try {
      decideExcessReceipt(deps, request({ quantity: 2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("STAFF는 초과입고를 결정할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, request, receipt } = excessScene();

    let thrown: unknown;
    try {
      decideExcessReceipt(deps, request({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(deps.excessDecisions.list("tenant-a", receipt.id)).toEqual([]);
  });
});
