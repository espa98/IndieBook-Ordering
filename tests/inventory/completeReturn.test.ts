import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { completeReturn } from "../../src/inventory/completeReturn";
import { completionScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("completeReturn: 반품 완료 (ST-C05, UC-28, BR-C02)", () => {
  it("공급처 최종 확인 근거와 함께 출고한 수량을 완료 처리하면 완료 기록이 남는다", () => {
    const { deps, completeRequest, returnRequestRecord } = completionScene(); // 요청 2, 수락 1, 출고 1

    const completion = completeReturn(deps, completeRequest({ quantity: 1 }));

    expect(completion).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      returnRequestId: returnRequestRecord.id,
      quantity: 1,
      evidence: "공급처 반품 입고 확인서 2026-03-06",
      confirmedBy: "김직원",
      confirmedAt: "2026-03-04T06:59:50.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.returnCompletions.list("tenant-a", returnRequestRecord.id)).toEqual([completion]);
  });

  it("완료는 출고한 수량까지만 가능하고(요청·수락만으로 완료로 보지 않는다) 기완료분을 합산한다", () => {
    const { deps, completeRequest, returnRequestRecord } = completionScene(); // 요청 2, 수락 1, 출고 1
    const complete = (quantity: number) => {
      try {
        completeReturn(deps, completeRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = complete(2); // 출고는 1뿐
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(complete(1)).toBeUndefined();
    expect(complete(1)).toBeInstanceOf(AppError); // 이미 완료
    expect(deps.returnCompletions.list("tenant-a", returnRequestRecord.id)).toHaveLength(1);
  });

  it("수량이 1 이상 정수가 아니거나 근거·확인자가 비었거나 confirmedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, completeRequest, returnRequestRecord } = completionScene();

    for (const bad of [
      completeRequest({ quantity: 0 }),
      completeRequest({ quantity: -1 }),
      completeRequest({ quantity: 1.5 }),
      completeRequest({ quantity: Number.NaN }),
      completeRequest({ evidence: " " }),
      completeRequest({ confirmedBy: "" }),
      completeRequest({ confirmedAt: "2026-03-04" }),
      completeRequest({ confirmedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        completeReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.returnCompletions.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("없는 반품 요청이거나 다른 테넌트의 요청이면 NOT_FOUND 404이다", () => {
    const { deps, completeRequest, returnRequestRecord } = completionScene();

    for (const bad of [
      completeRequest({ returnRequestId: "no-such-request" }),
      completeRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        completeReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.returnCompletions.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 완료를 돌려주고 중복 완료하지 않는다", () => {
    const { deps, completeRequest, returnRequestRecord } = completionScene();

    const first = completeReturn(deps, completeRequest({ idempotencyKey: "k" }));
    const replay = completeReturn(deps, completeRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.returnCompletions.list("tenant-a", returnRequestRecord.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, completeRequest, returnRequestRecord } = completionScene();
    completeReturn(deps, completeRequest({ evidence: "확인서 A", idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      completeReturn(deps, completeRequest({ evidence: "확인서 B", idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.returnCompletions.list("tenant-a", returnRequestRecord.id)).toHaveLength(1);
  });
});
