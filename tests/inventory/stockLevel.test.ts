import { describe, it, expect } from "vitest";
import { adjustStock } from "../../src/inventory/adjustStock";
import { stockLevel } from "../../src/inventory/stockLevel";
import { adjustScene } from "../helpers/stockFixtures";

describe("stockLevel: 보유·예약·가용 수량 파생 (BR-Q09, BR-Q10)", () => {
  it("on_hand는 원장의 순합계, available은 on_hand-reserved이다", () => {
    const { deps, adjustRequest, stockMovements, stockReservations } = adjustScene(); // 초기 5
    const levelOf = () =>
      stockLevel(
        stockMovements.list("tenant-a", "book-1"),
        stockReservations.list("tenant-a", "book-1"),
      );

    expect(levelOf()).toEqual({ onHand: 5, reserved: 0, available: 5 });

    adjustStock(deps, adjustRequest({ direction: "IN", quantity: 3 }));
    adjustStock(deps, adjustRequest({ direction: "OUT", quantity: 2, reason: "파손" }));
    expect(levelOf()).toEqual({ onHand: 6, reserved: 0, available: 6 });

    stockReservations.save({
      id: "res-1",
      tenantId: "tenant-a",
      bookId: "book-1",
      orderId: "order-1",
      orderLineId: "line-1",
      quantity: 4,
    });
    expect(levelOf()).toEqual({ onHand: 6, reserved: 4, available: 2 });
  });
});
