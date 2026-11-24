import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { resolveReturnException } from "../../src/inventory/resolveReturnException";
import { resolutionScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolveReturnException: 반품 예외 해소 (ST-C09, UC-28, D31)", () => {
  it("실물 회수와 검수를 확인하면 RECOVERED 해소 기록이 남고 원 예외 기록은 바뀌지 않는다", () => {
    const { deps, resolveRequest, returnException, returnRequestRecord } = resolutionScene();
    const exceptionBefore = structuredClone(returnException);

    const resolution = resolveReturnException(deps, resolveRequest({ outcome: "RECOVERED" }));

    expect(resolution).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      returnExceptionId: returnException.id,
      returnRequestId: returnRequestRecord.id,
      outcome: "RECOVERED",
      quantity: 1,
      evidence: "실물 회수 및 검수 완료 2026-03-08",
      resolvedBy: "김직원",
      resolvedAt: "2026-03-04T06:59:58.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.returnExceptionResolutions.list("tenant-a", returnException.id)).toEqual([resolution]);
    expect(deps.returnExceptions.get("tenant-a", returnException.id)).toEqual(exceptionBefore);
  });

  it("해소 합계는 신고된 예외 수량(1)을 넘을 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const { deps, resolveRequest, returnException } = resolutionScene();
    const resolve = (quantity: number, outcome: "RECOVERED" | "RETURNED" = "RECOVERED") => {
      try {
        resolveReturnException(deps, resolveRequest({ quantity, outcome }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = resolve(2);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(resolve(1)).toBeUndefined();
    expect(resolve(1, "RETURNED")).toBeInstanceOf(AppError); // 이미 해소됨
    expect(deps.returnExceptionResolutions.list("tenant-a", returnException.id)).toHaveLength(1);
  });

  it("수량이 1 이상 정수가 아니거나 결과가 잘못이거나 근거·담당자가 비었거나 resolvedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, resolveRequest, returnException } = resolutionScene();

    for (const bad of [
      resolveRequest({ quantity: 0 }),
      resolveRequest({ quantity: 1.5 }),
      resolveRequest({ quantity: Number.NaN }),
      resolveRequest({ outcome: "AUTO" as never }),
      resolveRequest({ evidence: " " }),
      resolveRequest({ resolvedBy: "" }),
      resolveRequest({ resolvedAt: "2026-03-04" }),
      resolveRequest({ resolvedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        resolveReturnException(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.returnExceptionResolutions.list("tenant-a", returnException.id)).toEqual([]);
  });

  it("없는 예외이거나 다른 테넌트의 예외면 NOT_FOUND 404이다", () => {
    const { deps, resolveRequest, returnException } = resolutionScene();

    for (const bad of [
      resolveRequest({ returnExceptionId: "no-such-exception" }),
      resolveRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        resolveReturnException(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.returnExceptionResolutions.list("tenant-a", returnException.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 해소를 돌려주고 중복 해소하지 않는다", () => {
    const { deps, resolveRequest, returnException } = resolutionScene();

    const first = resolveReturnException(deps, resolveRequest({ idempotencyKey: "k" }));
    const replay = resolveReturnException(deps, resolveRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.returnExceptionResolutions.list("tenant-a", returnException.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, resolveRequest, returnException } = resolutionScene();
    resolveReturnException(deps, resolveRequest({ outcome: "RECOVERED", idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      resolveReturnException(deps, resolveRequest({ outcome: "RETURNED", idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.returnExceptionResolutions.list("tenant-a", returnException.id)).toHaveLength(1);
  });
});
