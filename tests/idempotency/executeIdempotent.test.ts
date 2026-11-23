import { describe, it, expect, vi } from "vitest";
import {
  createIdempotencyStore,
  executeIdempotent,
} from "../../src/idempotency/executeIdempotent";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";

describe("executeIdempotent", () => {
  it("같은 키·같은 본문으로 재시도하면 실행은 한 번만 하고 저장된 결과를 반환한다", () => {
    const store = createIdempotencyStore();
    const action = vi.fn(() => ({ orderId: "o-1" }));
    const request = {
      tenantId: "tenant-a",
      operation: "orders.confirm",
      key: "key-1",
      payload: { orderId: "o-1", expectedVersion: 1 },
    };

    const first = executeIdempotent(store, request, action);
    const second = executeIdempotent(store, request, action);

    expect(first).toEqual({ orderId: "o-1" });
    expect(second).toEqual(first);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("객체 키 순서만 다른 같은 본문은 같은 요청으로 취급한다 (canonical payload)", () => {
    const store = createIdempotencyStore();
    const action = vi.fn(() => ({ orderId: "o-1" }));
    const base = { tenantId: "tenant-a", operation: "orders.create", key: "key-1" };

    const first = executeIdempotent(
      store,
      {
        ...base,
        payload: { customer: { name: "홍길동", phone: "010" }, lines: [{ a: 1, b: 2 }] },
      },
      action,
    );
    const second = executeIdempotent(
      store,
      {
        ...base,
        payload: { lines: [{ b: 2, a: 1 }], customer: { phone: "010", name: "홍길동" } },
      },
      action,
    );

    expect(second).toEqual(first);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["빈 문자열", ""],
    ["공백만", "   "],
    ["undefined", undefined],
    ["null", null],
    ["숫자", 123],
  ])(
    "멱등키가 비어 있지 않은 문자열이 아니면(%s) 400 VALIDATION_ERROR이고 실행도 저장도 하지 않는다",
    (_name, key) => {
      const store = createIdempotencyStore();
      const action = vi.fn(() => "done");
      const request = {
        tenantId: "tenant-a",
        operation: "orders.create",
        key: key as unknown as string,
        payload: { n: 1 },
      };

      const error = thrown(() => executeIdempotent(store, request, action));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(/^VALIDATION_ERROR: .*Idempotency-Key/);
      expect(action).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    },
  );

  it("같은 키·다른 본문의 충돌은 AppError(IDEMPOTENCY_CONFLICT, HTTP 409)이다", () => {
    const store = createIdempotencyStore();
    const base = { tenantId: "tenant-a", operation: "orders.confirm", key: "key-1" };
    executeIdempotent(store, { ...base, payload: { n: 1 } }, () => "first");

    const error = thrown(() =>
      executeIdempotent(store, { ...base, payload: { n: 2 } }, () => "second"),
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((error as AppError).httpStatus).toBe(409);
  });

  it("같은 키에 다른 본문이면 IDEMPOTENCY_CONFLICT로 거부하고 실행하지 않는다", () => {
    const store = createIdempotencyStore();
    const action = vi.fn(() => ({ orderId: "o-1" }));
    const base = { tenantId: "tenant-a", operation: "orders.confirm", key: "key-1" };

    executeIdempotent(
      store,
      { ...base, payload: { orderId: "o-1", expectedVersion: 1 } },
      action,
    );

    expect(() =>
      executeIdempotent(
        store,
        { ...base, payload: { orderId: "o-2", expectedVersion: 1 } },
        action,
      ),
    ).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
