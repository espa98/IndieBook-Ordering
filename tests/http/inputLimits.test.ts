import { describe, expect, it } from "vitest";
import { assertWithinLimits, INPUT_LIMITS } from "../../src/http/inputLimits";
import { AppError } from "../../src/errors/AppError";

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : "NON_APP_ERROR";
  }
};

describe("입력 상한 (E4)", () => {
  it("문자열은 1,000자까지 허용하고(한글도 글자 수 기준) 넘으면 VALIDATION_ERROR이다", () => {
    expect(INPUT_LIMITS).toEqual({ maxArrayItems: 100, maxStringLength: 1000, maxMoneyDigits: 15 });
    expect(codeOf(() => assertWithinLimits({ reason: "가".repeat(1000) }))).toBeUndefined();
    expect(codeOf(() => assertWithinLimits({ reason: "가".repeat(1001) }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => assertWithinLimits({ nested: { deep: [{ note: "x".repeat(1001) }] } }))).toBe("VALIDATION_ERROR"); // 중첩 값도 본다
  });

  it("배열은 100개까지 허용하고, 금액(`...Krw`) 문자열은 숫자 15자리까지만 허용한다", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ quantity: i + 1 }));
    expect(codeOf(() => assertWithinLimits({ lines: items(100) }))).toBeUndefined();
    expect(codeOf(() => assertWithinLimits({ lines: items(101) }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => assertWithinLimits({ order: { allocationIds: Array(101).fill("a") } }))).toBe("VALIDATION_ERROR"); // 중첩 배열도 본다

    expect(codeOf(() => assertWithinLimits({ amountKrw: "9".repeat(15) }))).toBeUndefined();
    expect(codeOf(() => assertWithinLimits({ amountKrw: "9".repeat(16) }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => assertWithinLimits({ lines: [{ unitPriceKrw: "1".repeat(16) }] }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => assertWithinLimits({ changes: { listPriceKrw: "1".repeat(16) } }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => assertWithinLimits({ amountKrw: "abc" }))).toBeUndefined(); // 형식 오류는 도메인이 거부한다
    expect(codeOf(() => assertWithinLimits({ note: "9".repeat(16) }))).toBeUndefined(); // 금액 필드가 아니면 숫자 자릿수 제한 없음
  });
});
