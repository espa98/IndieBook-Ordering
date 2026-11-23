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
});
