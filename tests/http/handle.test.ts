import { describe, it, expect, vi } from "vitest";
import { handle } from "../../src/http/handle";
import { toErrorResponse } from "../../src/http/toErrorResponse";
import { AppError } from "../../src/errors/AppError";

describe("handle", () => {
  it("성공하면 기본 200, successStatus를 주면 그 상태로 { data }를 반환한다", () => {
    expect(handle(() => ({ orderId: "o-1" }))).toEqual({
      status: 200,
      body: { data: { orderId: "o-1" } },
    });

    expect(handle(() => ({ orderId: "o-1" }), { successStatus: 201 })).toEqual({
      status: 201,
      body: { data: { orderId: "o-1" } },
    });
  });

  it.each([
    new AppError("VALIDATION_ERROR", "limit must be an integer 1..100"),
    new AppError("FORBIDDEN"),
  ])("fn이 AppError(%s)를 던지면 예외를 전파하지 않고 toErrorResponse와 같은 응답을 반환한다", (error) => {
    let response: unknown;

    expect(() => {
      response = handle(() => {
        throw error;
      });
    }).not.toThrow();

    expect(response).toEqual(toErrorResponse(error));
  });

  describe("onUnexpectedError 훅 (서버측 로깅 자리)", () => {
    const INTERNAL = {
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    };

    it("AppError가 아닌 오류는 원본 그대로 정확히 한 번 훅에 전달하고, 응답은 500으로 원본을 숨긴다", () => {
      const onUnexpectedError = vi.fn();
      const boom = new Error("db password=hunter2");

      const response = handle(
        () => {
          throw boom;
        },
        { onUnexpectedError },
      );

      expect(onUnexpectedError).toHaveBeenCalledTimes(1);
      expect(onUnexpectedError).toHaveBeenCalledWith(boom);
      expect(response).toEqual(INTERNAL);
      expect(JSON.stringify(response)).not.toContain("hunter2");
    });

    it("성공이나 AppError에서는 훅을 호출하지 않는다", () => {
      const onUnexpectedError = vi.fn();

      handle(() => "ok", { onUnexpectedError });
      handle(
        () => {
          throw new AppError("NOT_FOUND");
        },
        { onUnexpectedError },
      );

      expect(onUnexpectedError).not.toHaveBeenCalled();
    });

    it("훅이 예외를 던져도 응답은 그대로 500이고 예외가 전파되지 않는다", () => {
      const onUnexpectedError = vi.fn(() => {
        throw new Error("logger is down");
      });
      let response: unknown;

      expect(() => {
        response = handle(
          () => {
            throw new Error("boom");
          },
          { onUnexpectedError },
        );
      }).not.toThrow();

      expect(response).toEqual(INTERNAL);
    });
  });
});
