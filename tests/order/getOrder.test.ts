import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { getOrder } from "../../src/order/getOrder";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { thrown } from "../helpers/thrown";
import { AppError } from "../../src/errors/AppError";

describe("getOrder", () => {
  it("보류·폐기 상태(시각·사유)를 상세에 싣고, 담당자 이름은 싣지 않는다", () => {
    const base = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" });
    const held = { ...base, heldAt: "2026-03-04T06:00:00.000Z", holdReason: "입금 확인", heldBy: "김직원" };
    const discarded = { ...base, discardedAt: "2026-03-04T07:00:00.000Z", discardReason: "철회", discardedBy: "이직원" };
    const orders = createInMemoryOrderRepository([held, { ...discarded, id: "other" }]);

    expect(getOrder({ orders }, { tenantId: "tenant-a", orderId: held.id })).toMatchObject({ heldAt: "2026-03-04T06:00:00.000Z", holdReason: "입금 확인" });
    const detail = getOrder({ orders }, { tenantId: "tenant-a", orderId: "other" });
    expect(detail).toMatchObject({ discardedAt: "2026-03-04T07:00:00.000Z", discardReason: "철회" });
    expect(JSON.stringify([getOrder({ orders }, { tenantId: "tenant-a", orderId: held.id }), detail])).not.toMatch(/김직원|이직원|heldBy|discardedBy/);
  });

  it("테넌트에 속한 주문의 상세(품목 포함)를 반환한다", () => {
    let order = createDraftOrder({
      tenantId: "tenant-a",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    order = addOrderLine(order, {
      bookId: "book-1",
      quantity: 2,
      unitPriceKrw: "15000",
    });
    const orders = createInMemoryOrderRepository([order]);

    const detail = getOrder(
      { orders },
      { tenantId: "tenant-a", orderId: order.id },
    );

    expect(detail).toEqual({
      id: order.id,
      status: "DRAFT",
      version: 1,
      createdAt: "2026-01-02T03:04:05.000Z",
      displayNumber: undefined,
      totalKrw: undefined,
      lines: [
        { lineId: expect.any(String), bookId: "book-1", quantity: 2, unitPriceKrw: "15000" },
      ],
    });
  });

  it("NOT_FOUND는 AppError(HTTP 404)이다", () => {
    const orders = createInMemoryOrderRepository();

    const error = thrown(() =>
      getOrder({ orders }, { tenantId: "tenant-a", orderId: "missing" }),
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("NOT_FOUND");
    expect((error as AppError).httpStatus).toBe(404);
  });

  it("없는 주문이거나 다른 테넌트의 주문이면 같은 NOT_FOUND로 거부한다", () => {
    const tenantBOrder = createDraftOrder({ tenantId: "tenant-b" });
    const orders = createInMemoryOrderRepository([tenantBOrder]);

    // 존재하지 않는 주문 ID
    expect(() =>
      getOrder(
        { orders },
        {
          tenantId: "tenant-a",
          orderId: "00000000-0000-4000-8000-000000000000",
        },
      ),
    ).toThrow(/^NOT_FOUND$/);

    // tenant-a가 tenant-b의 주문 ID로 접근: 존재 여부가 드러나면 안 된다
    expect(() =>
      getOrder(
        { orders },
        { tenantId: "tenant-a", orderId: tenantBOrder.id },
      ),
    ).toThrow(/^NOT_FOUND$/);
  });
});
