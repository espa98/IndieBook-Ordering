import { describe, it, expect } from "vitest";
import { normalizePhone } from "../../src/customer/normalizePhone";
import type { AppError } from "../../src/errors/AppError";

describe("normalizePhone: 국내 번호 정규화 (고객 결정 #6)", () => {
  it("하이픈·공백을 제거해 숫자만 남기고, 국내 휴대전화 형식이면 그 값을 돌려준다", () => {
    expect(normalizePhone("010-1234-5678")).toBe("01012345678");
    expect(normalizePhone(" 010 1234 5678 ")).toBe("01012345678");
  });

  it("+82 국제 접두는 국내 0 형식으로 바꾼다", () => {
    expect(normalizePhone("+82 10-1234-5678")).toBe("01012345678");
    expect(normalizePhone("+82-2-123-4567")).toBe("021234567");
  });

  it("국내 휴대전화·지역번호 형식이 아니면 VALIDATION_ERROR 400이다", () => {
    for (const bad of ["", "abc", "1234", "010-12", "+1 415 555 0100", "0101234567890123"]) {
      try {
        normalizePhone(bad);
        expect.unreachable(bad);
      } catch (error) {
        expect((error as AppError).code, bad).toBe("VALIDATION_ERROR");
      }
    }
  });

  it("문자열이 아닌 입력도 TypeError가 아니라 VALIDATION_ERROR 400이다", () => {
    for (const bad of [null, undefined, 1012345678, {}, ["010"]]) {
      try {
        normalizePhone(bad as never);
        expect.unreachable(String(bad));
      } catch (error) {
        expect((error as AppError).code, String(bad)).toBe("VALIDATION_ERROR");
      }
    }
  });
});
