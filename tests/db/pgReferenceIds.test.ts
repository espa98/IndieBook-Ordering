import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { assertReferenceIds, withReferenceIds } from "../../src/db/pgSupport";

const UUID = "0a000000-0000-4000-8000-000000000001";
const codeOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};

describe("assertReferenceIds: 본문의 참조 ID는 uuid 형식이어야 한다", () => {
  it("지정한 필드가 uuid가 아니면 VALIDATION_ERROR이고, uuid면 통과하며, 지정하지 않은 필드는 보지 않는다", () => {
    expect(codeOf(() => assertReferenceIds({ orderLineId: UUID }, ["orderLineId"]))).toBeUndefined();
    for (const bad of ["not-a-uuid", "", " ", 123, null, {}, [UUID]]) {
      expect(codeOf(() => assertReferenceIds({ orderLineId: bad }, ["orderLineId"])), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect(codeOf(() => assertReferenceIds({ orderLineId: UUID, note: "아무 값" }, ["orderLineId"]))).toBeUndefined();
  });

  it("값이 없는 필드(undefined)는 필수 여부를 도메인이 판단하므로 통과시키고, optional로 표시한 필드는 생략을 허용한다", () => {
    // 필수 필드의 누락은 도메인이 400으로 거부한다. 이 헬퍼는 형식만 본다
    expect(codeOf(() => assertReferenceIds({}, ["orderLineId"]))).toBeUndefined();
    expect(codeOf(() => assertReferenceIds({ orderLineId: undefined }, ["orderLineId"]))).toBeUndefined();
  });

  it("여러 필드를 한 번에 확인하고, 어느 필드가 문제인지 메시지에 이름만 담는다(값은 되돌리지 않는다)", () => {
    expect(codeOf(() => assertReferenceIds({ a: UUID, b: UUID }, ["a", "b"]))).toBeUndefined();
    let thrown: unknown;
    try {
      assertReferenceIds({ a: UUID, b: "SECRET-VALUE-123" }, ["a", "b"]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AppError).detail).toContain("b");
    expect(String((thrown as AppError).detail)).not.toContain("SECRET-VALUE-123");
  });
});

describe("assertReferenceIds: 배열 필드는 모든 원소가 uuid여야 한다", () => {
  it("배열의 원소 중 하나라도 uuid가 아니면 VALIDATION_ERROR이고(어느 필드인지 이름만 알린다), 모두 uuid거나 빈 배열이면 통과한다", () => {
    const B = "0a000000-0000-4000-8000-000000000002";
    expect(codeOf(() => assertReferenceIds({ allocationIds: [UUID, B] }, ["allocationIds[]"]))).toBeUndefined();
    expect(codeOf(() => assertReferenceIds({ allocationIds: [] }, ["allocationIds[]"]))).toBeUndefined(); // 비어 있는지는 도메인이 판단한다
    for (const bad of [[UUID, "not-a-uuid"], ["not-a-uuid", UUID], [UUID, ""], [UUID, 123], [null]]) {
      expect(codeOf(() => assertReferenceIds({ allocationIds: bad }, ["allocationIds[]"])), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    // 배열이 아닌 값은 도메인이 형식 오류로 거부하므로 이 헬퍼는 건드리지 않는다
    expect(codeOf(() => assertReferenceIds({ allocationIds: "x" }, ["allocationIds[]"]))).toBeUndefined();
    let thrown: unknown;
    try {
      assertReferenceIds({ allocationIds: [UUID, "SECRET-VALUE"] }, ["allocationIds[]"]);
    } catch (error) {
      thrown = error;
    }
    expect(String((thrown as AppError).detail)).toContain("allocationIds");
    expect(String((thrown as AppError).detail)).not.toContain("SECRET-VALUE");
  });
});

describe("withReferenceIds: 도메인 호출이 조회 실패(NOT_FOUND·BUSINESS_INVARIANT)로 끝날 때만 참조 ID 형식을 확인해 400으로 바꾼다", () => {
  const throwing = (error: unknown) => () => {
    throw error;
  };

  it("도메인이 성공하면 결과를 그대로 돌려주되 형식이 틀린 참조 ID는 거부하고, 권한·입력 검증 오류는 형식 확인보다 앞선다", () => {
    expect(withReferenceIds({ orderLineId: UUID }, ["orderLineId"], () => "결과")).toBe("결과");
    // 도메인이 성공했는데 형식이 틀렸다면(조회에 쓰이지 않은 필드) 그대로 통과시키지 않는다
    expect(codeOf(() => withReferenceIds({ orderLineId: "not-a-uuid" }, ["orderLineId"], () => "결과"))).toBe("VALIDATION_ERROR");
    // 도메인의 권한·입력 검증 오류는 그대로 앞선다
    expect(codeOf(() => withReferenceIds({ orderLineId: "not-a-uuid" }, ["orderLineId"], throwing(new AppError("FORBIDDEN"))))).toBe("FORBIDDEN");
    expect(codeOf(() => withReferenceIds({ orderLineId: "not-a-uuid" }, ["orderLineId"], throwing(new AppError("VALIDATION_ERROR", "다른 필드"))))).toBe("VALIDATION_ERROR");
  });

  it("도메인이 NOT_FOUND·BUSINESS_INVARIANT로 끝났을 때 형식이 틀린 참조 ID면 VALIDATION_ERROR로 바꾸고, uuid 형식이면 원래 오류를 그대로 던진다", () => {
    for (const code of ["NOT_FOUND", "BUSINESS_INVARIANT"] as const) {
      expect(codeOf(() => withReferenceIds({ orderLineId: "not-a-uuid" }, ["orderLineId"], throwing(new AppError(code))))).toBe("VALIDATION_ERROR");
      expect(codeOf(() => withReferenceIds({ orderLineId: UUID }, ["orderLineId"], throwing(new AppError(code))))).toBe(code);
    }
    // AppError가 아닌 오류는 건드리지 않는다
    expect(codeOf(() => withReferenceIds({ orderLineId: "not-a-uuid" }, ["orderLineId"], throwing(new Error("boom"))))).toBe("NON_APP_ERROR:boom");
  });
});

