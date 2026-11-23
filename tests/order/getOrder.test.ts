import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { getOrder } from "../../src/order/getOrder";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";

describe("getOrder", () => {
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
      lines: [{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }],
    });
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
