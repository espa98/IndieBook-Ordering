import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { completeReturn } from "../../src/inventory/completeReturn";
import { reportReturnException } from "../../src/inventory/reportReturnException";
import { exceptionScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("reportReturnException: 반품 반송·분실·거절 예외 신고 (ST-C08, UC-28, D31)", () => {
  it("출고한 수량 중 반송이 확인되면 사유·근거와 함께 예외 기록이 남고 반품 요청은 바뀌지 않는다", () => {
    const { deps, exceptionRequest, returnRequestRecord } = exceptionScene(); // 출고 1
    const requestBefore = structuredClone(returnRequestRecord);

    const exception = reportReturnException(deps, exceptionRequest({ quantity: 1 }));

    expect(exception).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      returnRequestId: returnRequestRecord.id,
      quantity: 1,
      kind: "RETURNED_BACK",
      evidence: "택배사 반송 통보 2026-03-07",
      reportedBy: "김직원",
      reportedAt: "2026-03-04T06:59:55.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.returnExceptions.list("tenant-a", returnRequestRecord.id)).toEqual([exception]);
    expect(deps.returnRequests.get("tenant-a", returnRequestRecord.id)).toEqual(requestBefore);
  });

  it("신고는 출고했지만 완료·기신고되지 않은 수량까지만 가능하다(출고 전 수량은 신고 불가)", () => {
    const { deps, exceptionRequest, completeRequest, returnRequestRecord } = exceptionScene(); // 요청 2, 출고 1
    const report = (quantity: number) => {
      try {
        reportReturnException(deps, exceptionRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = report(2); // 출고는 1뿐
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);

    completeReturn(deps, completeRequest({ quantity: 1 })); // 출고분이 정상 완료됨
    expect(report(1)).toBeInstanceOf(AppError); // 완료된 수량은 예외로 돌릴 수 없다
    expect(deps.returnExceptions.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("수량이 1 이상 정수가 아니거나 종류가 잘못이거나 근거·신고자가 비었거나 reportedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, exceptionRequest, returnRequestRecord } = exceptionScene();

    for (const bad of [
      exceptionRequest({ quantity: 0 }),
      exceptionRequest({ quantity: 1.5 }),
      exceptionRequest({ quantity: Number.NaN }),
      exceptionRequest({ kind: "BROKEN" as never }),
      exceptionRequest({ evidence: " " }),
      exceptionRequest({ reportedBy: "" }),
      exceptionRequest({ reportedAt: "2026-03-04" }),
      exceptionRequest({ reportedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        reportReturnException(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.returnExceptions.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("없는 반품 요청이거나 다른 테넌트의 요청이면 NOT_FOUND 404이다", () => {
    const { deps, exceptionRequest, returnRequestRecord } = exceptionScene();

    for (const bad of [
      exceptionRequest({ returnRequestId: "no-such-request" }),
      exceptionRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        reportReturnException(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.returnExceptions.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 예외를 돌려주고 중복 신고하지 않는다", () => {
    const { deps, exceptionRequest, returnRequestRecord } = exceptionScene();

    const first = reportReturnException(deps, exceptionRequest({ idempotencyKey: "k" }));
    const replay = reportReturnException(deps, exceptionRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.returnExceptions.list("tenant-a", returnRequestRecord.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, exceptionRequest, returnRequestRecord } = exceptionScene();
    reportReturnException(deps, exceptionRequest({ kind: "LOST", idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      reportReturnException(deps, exceptionRequest({ kind: "REFUSED", idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.returnExceptions.list("tenant-a", returnRequestRecord.id)).toHaveLength(1);
  });
});
