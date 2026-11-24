import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { allocateReceipt } from "../../src/inventory/allocateReceipt";
import { correctReceipt } from "../../src/inventory/correctReceipt";
import { correctionScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("correctReceipt: 입고 정정 (ST-R03, UC-23, DEC-09, BR-Q20)", () => {
  it("Owner가 미배분 정상량을 정정하면 원 입고를 가리키는 보정 기록이 남고 입고 기록은 바뀌지 않는다", () => {
    const { deps, correctRequest, receipt } = correctionScene();
    const receiptBefore = structuredClone(receipt);

    const correction = correctReceipt(deps, correctRequest({ quantity: 1 }));

    expect(correction).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      receiptId: receipt.id,
      quantity: 1,
      reason: "검수 수량 오기입, 실제로는 3권",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:45:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.receiptCorrections.list("tenant-a", receipt.id)).toEqual([correction]);
    expect(deps.receipts.get("tenant-a", receipt.id)).toEqual(receiptBefore);
  });

  it("정정 합계가 미배분 잔량을 넘으면 BUSINESS_INVARIANT 422이다(이미 배분된 양은 먼저 해제해야 한다)", () => {
    const { deps, correctRequest, allocateRequest, receipt, orders } = correctionScene();
    allocateReceipt(
      deps,
      allocateRequest({ orderId: orders[1]!.id, orderLineId: orders[1]!.lines[0]!.lineId, quantity: 3 }),
    ); // 4권 중 3권 배분 -> 미배분 1
    const correct = (quantity: number) => {
      try {
        correctReceipt(deps, correctRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = correct(2);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(correct(1)).toBeUndefined(); // 미배분 1 -> 0
    expect(correct(1)).toBeInstanceOf(AppError); // 더 차감할 미배분이 없다
    expect(deps.receiptCorrections.list("tenant-a", receipt.id)).toHaveLength(1);
  });

  it("STAFF는 입고를 정정할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, correctRequest, receipt } = correctionScene();

    let thrown: unknown;
    try {
      correctReceipt(deps, correctRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(deps.receiptCorrections.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("수량이 1 이상 정수가 아니거나 사유·담당자가 비었거나 correctedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, correctRequest, receipt } = correctionScene();
    const depsAt = { ...deps, now: () => new Date("2026-03-04T07:00:00.000Z") };

    for (const bad of [
      correctRequest({ quantity: 0 }),
      correctRequest({ quantity: -1 }),
      correctRequest({ quantity: 1.5 }),
      correctRequest({ quantity: Number.NaN }),
      correctRequest({ reason: " " }),
      correctRequest({ correctedBy: "" }),
      correctRequest({ correctedAt: "2026-03-04" }),
      correctRequest({ correctedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        correctReceipt(depsAt, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.receiptCorrections.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("없는 입고이거나 다른 테넌트의 입고면 NOT_FOUND 404이다", () => {
    const { deps, correctRequest, receipt } = correctionScene();

    for (const bad of [
      correctRequest({ receiptId: "no-such-receipt" }),
      correctRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        correctReceipt(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.receiptCorrections.list("tenant-a", receipt.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 정정을 돌려주고 중복 기록하지 않는다", () => {
    const { deps, correctRequest, receipt } = correctionScene();

    const first = correctReceipt(deps, correctRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = correctReceipt(deps, correctRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.receiptCorrections.list("tenant-a", receipt.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, correctRequest, receipt } = correctionScene();
    correctReceipt(deps, correctRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      correctReceipt(deps, correctRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.receiptCorrections.list("tenant-a", receipt.id)).toHaveLength(1);
  });
});
