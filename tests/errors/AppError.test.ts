import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";

describe("AppError", () => {
  it.each([
    ["VALIDATION_ERROR", 400],
    ["UNAUTHENTICATED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["VERSION_CONFLICT", 409],
    ["BUSINESS_INVARIANT", 422],
  ] as const)("%s는 HTTP %i로 매핑되고 message는 코드 그대로다", (code, status) => {
    const error = new AppError(code);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe("AppError");
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.message).toBe(code);
  });

  it("detail은 별도 속성으로 노출되고, 없으면 undefined이다 (message 형식은 유지)", () => {
    const withDetail = new AppError("VALIDATION_ERROR", "limit must be an integer 1..100");
    const withoutDetail = new AppError("NOT_FOUND");

    expect(withDetail.detail).toBe("limit must be an integer 1..100");
    expect(withDetail.message).toBe("VALIDATION_ERROR: limit must be an integer 1..100");
    expect(withoutDetail.detail).toBeUndefined();
  });
});
