import { describe, it, expect } from "vitest";
import { createOrderService } from "../../src/order/createOrderService";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { thrown } from "../helpers/thrown";
import { AppError } from "../../src/errors/AppError";

describe("createOrderService", () => {
  it("품목이 담긴 DRAFT 주문을 만들어 저장하고 반환한다", () => {
    const orders = createInMemoryOrderRepository();

    const created = createOrderService(
      { orders, idempotency: createIdempotencyStore() },
      {
        tenantId: "tenant-a",
        idempotencyKey: "key-1",
        lines: [
          { bookId: "book-1", quantity: 2, unitPriceKrw: "15000" },
          { bookId: "book-2", quantity: 1, unitPriceKrw: "9000" },
        ],
      },
    );

    expect(created.status).toBe("DRAFT");
    expect(created.tenantId).toBe("tenant-a");
    expect(created.version).toBe(1);
    expect(created.lines).toEqual([
      { bookId: "book-1", quantity: 2, unitPriceKrw: "15000" },
      { bookId: "book-2", quantity: 1, unitPriceKrw: "9000" },
    ]);
    expect(orders.get("tenant-a", created.id)).toEqual(created);
  });

  it("같은 멱등키·같은 본문으로 재시도하면 같은 주문을 반환하고 중복 생성하지 않는다", () => {
    const orders = createInMemoryOrderRepository();
    const deps = { orders, idempotency: createIdempotencyStore() };
    const request = {
      tenantId: "tenant-a",
      idempotencyKey: "key-1",
      lines: [{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }],
    };

    const first = createOrderService(deps, request);
    const retry = createOrderService(deps, request);

    expect(retry.id).toBe(first.id);
    expect(retry).toEqual(first);
    expect(orders.list("tenant-a")).toHaveLength(1);
  });

  it.each([
    ["undefined(누락)", undefined],
    ["null", null],
    ["문자열", "x"],
    ["객체", { bookId: "b" }],
    ["원소가 null", [null]],
    ["원소가 문자열", ["x"]],
    ["원소가 배열", [[]]],
  ])(
    "lines가 객체 배열이 아니면(%s) 400 VALIDATION_ERROR이고 아무것도 저장하지 않는다 (500이 아님)",
    (_name, lines) => {
      const orders = createInMemoryOrderRepository();

      const error = thrown(() =>
        createOrderService(
          { orders, idempotency: createIdempotencyStore() },
          {
            tenantId: "tenant-a",
            idempotencyKey: "key-1",
            lines: lines as unknown as [],
          },
        ),
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(/^VALIDATION_ERROR: .*lines/);
      expect(orders.list("tenant-a")).toHaveLength(0);
    },
  );

  it("품목이 0개인 빈 초안도 만들 수 있다 (확정 시 최소 1품목 규칙은 confirmOrder가 담당)", () => {
    const orders = createInMemoryOrderRepository();

    const created = createOrderService(
      { orders, idempotency: createIdempotencyStore() },
      { tenantId: "tenant-a", idempotencyKey: "key-1", lines: [] },
    );

    expect(created.status).toBe("DRAFT");
    expect(created.lines).toEqual([]);
    expect(orders.get("tenant-a", created.id)).toEqual(created);
  });

  it("같은 멱등키에 다른 품목이면 IDEMPOTENCY_CONFLICT이고 새 주문을 만들지 않는다", () => {
    const orders = createInMemoryOrderRepository();
    const deps = { orders, idempotency: createIdempotencyStore() };
    const base = { tenantId: "tenant-a", idempotencyKey: "key-1" };

    createOrderService(deps, {
      ...base,
      lines: [{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }],
    });

    expect(() =>
      createOrderService(deps, {
        ...base,
        lines: [{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }],
      }),
    ).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(orders.list("tenant-a")).toHaveLength(1);
  });

  it.each([
    ["quantity 0", { bookId: "book-1", quantity: 0, unitPriceKrw: "15000" }],
    ["소수 단가", { bookId: "book-1", quantity: 1, unitPriceKrw: "15000.5" }],
  ])("잘못된 품목(%s)이 하나라도 있으면 거부하고 아무것도 저장하지 않는다", (_name, bad) => {
    const orders = createInMemoryOrderRepository();

    expect(() =>
      createOrderService(
        { orders, idempotency: createIdempotencyStore() },
        {
          tenantId: "tenant-a",
          idempotencyKey: "key-1",
          lines: [
            { bookId: "book-0", quantity: 1, unitPriceKrw: "1000" },
            bad,
          ],
        },
      ),
    ).toThrow();
    expect(orders.list("tenant-a")).toHaveLength(0);
  });
});
