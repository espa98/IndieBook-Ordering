import { describe, it, expect } from "vitest";
import { toErrorResponse } from "../../src/http/toErrorResponse";
import { AppError } from "../../src/errors/AppError";

describe("toErrorResponse", () => {
  it("VALIDATION_ERROR는 400이고 본문 message에 detail이 담긴다", () => {
    const response = toErrorResponse(
      new AppError("VALIDATION_ERROR", "limit must be an integer 1..100"),
    );

    expect(response).toEqual({
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "limit must be an integer 1..100",
        },
      },
    });
  });

  it("detail이 없는 VALIDATION_ERROR는 고정 문구로 응답한다", () => {
    const response = toErrorResponse(new AppError("VALIDATION_ERROR"));

    expect(response).toEqual({
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid request" } },
    });
  });

  it.each([
    ["UNAUTHENTICATED", 401, "Authentication required"],
    ["FORBIDDEN", 403, "Access denied"],
    ["NOT_FOUND", 404, "Resource not found"],
    [
      "IDEMPOTENCY_CONFLICT",
      409,
      "Idempotency key was already used with a different request",
    ],
    ["VERSION_CONFLICT", 409, "The resource was modified; reload and retry"],
    ["BUSINESS_INVARIANT", 422, "The request violates a business rule"],
  ] as const)(
    "%s는 HTTP %i이고 detail이 있어도 노출하지 않고 고정 문구를 쓴다",
    (code, status, message) => {
      const response = toErrorResponse(
        new AppError(code, "internal rule: tenant-b order exists"),
      );

      expect(response).toEqual({
        status,
        body: { error: { code, message } },
      });
      expect(JSON.stringify(response)).not.toContain("tenant-b");
    },
  );

  it.each([
    ["일반 Error", new Error("db password=hunter2 at pg://internal-host")],
    ["문자열", "db password=hunter2"],
    ["null", null],
    ["undefined", undefined],
    ["임의 객체", { code: "FORBIDDEN", httpStatus: 403, secret: "hunter2" }],
    ["TypeError", new TypeError("Cannot read properties of undefined")],
  ])(
    "AppError가 아닌 입력(%s)은 500 INTERNAL_ERROR 고정 문구이고 원본을 노출하지 않으며 예외를 던지지 않는다",
    (_name, input) => {
      let response: ReturnType<typeof toErrorResponse> | undefined;

      expect(() => {
        response = toErrorResponse(input);
      }).not.toThrow();

      expect(response).toEqual({
        status: 500,
        body: {
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        },
      });
      expect(JSON.stringify(response)).not.toMatch(/hunter2|internal-host|Cannot read/);
    },
  );
});
