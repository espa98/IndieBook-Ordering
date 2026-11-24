import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { addOrderLine } from "../../src/order/addOrderLine";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { reserveStock } from "../../src/inventory/reserveStock";
import { releaseScene } from "../helpers/inventoryFixtures";
import { deliverStockReservation } from "../../src/inventory/deliverStockReservation";
import { releaseStockReservation } from "../../src/inventory/releaseStockReservation";
import { adjustScene, reservationDeliveryScene, reservationReleaseScene, reservationScene } from "../helpers/stockFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("reserveStock: 주문 품목의 매장 재고 예약 (ST-I03, UC-27, BR-Q03~Q10)", () => {
  it("확정 주문 품목에 가용 재고를 예약하면 예약 기록이 남고 재고 원장은 바뀌지 않는다 (보유 불변, 예약 증가)", () => {
    const { deps, reserveRequest, order, stockMovements, stockReservations } = reservationScene();
    const movementsBefore = structuredClone(stockMovements.list("tenant-a", "book-1"));

    const reservation = reserveStock(deps, reserveRequest({ quantity: 2 }));

    expect(reservation).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      orderId: order.id,
      orderLineId: order.lines[0]!.lineId,
      quantity: 2,
      reservedBy: "김직원",
      reservedAt: "2026-03-04T06:40:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(stockReservations.list("tenant-a", "book-1")).toEqual([reservation]);
    expect(stockMovements.list("tenant-a", "book-1")).toEqual(movementsBefore);
  });

  it("없는 주문·품목이나 다른 테넌트의 주문은 NOT_FOUND 404, 확정 전 초안 주문은 BUSINESS_INVARIANT 422이다", () => {
    const { deps, reserveRequest, order, stockReservations } = reservationScene();
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });
    deps.orders.save(draft);
    const codeOf = (request: ReturnType<typeof reserveRequest>) => {
      try {
        reserveStock(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(reserveRequest({ orderId: "no-such-order" }))).toBe("NOT_FOUND");
    expect(codeOf(reserveRequest({ orderLineId: "no-such-line" }))).toBe("NOT_FOUND");
    expect(codeOf(reserveRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(
      codeOf(reserveRequest({ orderId: draft.id, orderLineId: draft.lines[0]!.lineId, quantity: 1 })),
    ).toBe("BUSINESS_INVARIANT");
    expect(order.status).toBe("CONFIRMED");
    expect(stockReservations.list("tenant-a", "book-1")).toEqual([]);
  });

  it("가용량(보유-예약)을 넘는 예약은 BUSINESS_INVARIANT 422이고, 두 주문이 마지막 1권을 다투면 한 건만 성공한다", () => {
    const { deps, reserveRequest, w, stockReservations } = reservationScene(); // 보유 5
    const big = w.addOrder([{ bookId: "book-1", quantity: 4, unitPriceKrw: "15000" }]);
    const small = w.addOrder([{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }]);
    const reserve = (order: typeof big, quantity: number) => {
      try {
        reserveStock(
          deps,
          reserveRequest({ orderId: order.id, orderLineId: order.lines[0]!.lineId, quantity }),
        );
      } catch (error) {
        return error;
      }
    };

    expect(reserve(big, 4)).toBeUndefined(); // 가용 5 -> 1
    const raced = [reserve(small, 1), reserve(small, 1)]; // 마지막 1권
    expect(raced.filter((r) => r === undefined)).toHaveLength(1);
    const failure = raced.find((r) => r !== undefined);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(stockReservations.list("tenant-a", "book-1").map((r) => r.quantity)).toEqual([4, 1]);
  });

  it("주문 품목의 미확보량(Need=E-R)을 넘는 예약은 가용 재고가 남아 있어도 BUSINESS_INVARIANT 422이다", () => {
    const { deps, reserveRequest, stockReservations } = reservationScene(); // 품목 2권, 보유 5
    const reserve = (quantity: number) => {
      try {
        reserveStock(deps, reserveRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    expect(reserve(1)).toBeUndefined(); // Need 2 -> 1
    const over = reserve(2); // Need 1 < 2
    expect(over).toBeInstanceOf(AppError);
    expect((over as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(reserve(1)).toBeUndefined(); // Need 0
    expect(reserve(1)).toBeInstanceOf(AppError);
    expect(stockReservations.list("tenant-a", "book-1").map((r) => r.quantity)).toEqual([1, 1]);
  });

  it("이미 공급처 발주 경로로 배정(조달 계획)된 수량은 미배정량에서 빠져 예약할 수 없다 (Unassigned=Need-Planned)", () => {
    const { deps, reserveRequest, w, order, stockReservations } = reservationScene(); // 품목 2권, 보유 5
    w.allocate(order, 0, 1); // 1권은 공급처 발주 경로

    const reserve = (quantity: number) => {
      try {
        reserveStock(deps, reserveRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const over = reserve(2); // 미배정량 1
    expect(over).toBeInstanceOf(AppError);
    expect((over as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(reserve(1)).toBeUndefined();
    expect(reserve(1)).toBeInstanceOf(AppError);
    expect(stockReservations.list("tenant-a", "book-1")).toHaveLength(1);
  });

  it("입고 배분으로 확보된 수량은 조달 계획에서 확보로 전환된 것이라 이중 차감되지 않고, 이미 전부 확보된 품목은 예약할 수 없다 (BR-Q19)", () => {
    const r = releaseScene(); // 주문 B: 3권, 발주 3권, 입고 배분 3권(Ready 3)
    const st = adjustScene(); // book-1 보유 5
    const deps = { ...st.deps, orders: r.w.deps.orders, sourcingAllocations: r.w.deps.allocations };
    const orderB = r.orders[1]!;

    let thrown: unknown;
    try {
      reserveStock(deps, {
        tenantId: "tenant-a",
        orderId: orderB.id,
        orderLineId: orderB.lines[0]!.lineId,
        quantity: 1,
        reservedBy: "김직원",
        reservedAt: "2026-03-04T06:40:00.000Z",
        idempotencyKey: "res-b",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(st.stockReservations.list("tenant-a", "book-1")).toEqual([]);
  });

  it("대상·담당자가 비었거나 수량이 1 이상 정수가 아니거나 reservedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, reserveRequest, stockReservations } = reservationScene(); // now = 2026-03-04T07:00Z

    for (const bad of [
      reserveRequest({ orderId: " " }),
      reserveRequest({ orderLineId: "" }),
      reserveRequest({ reservedBy: "" }),
      reserveRequest({ quantity: 0 }),
      reserveRequest({ quantity: -1 }),
      reserveRequest({ quantity: 1.5 }),
      reserveRequest({ quantity: Number.NaN }),
      reserveRequest({ reservedAt: "2026-03-04" }),
      reserveRequest({ reservedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        reserveStock(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(stockReservations.list("tenant-a", "book-1")).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 예약을 돌려주고 중복 예약하지 않는다", () => {
    const { deps, reserveRequest, stockReservations } = reservationScene();

    const first = reserveStock(deps, reserveRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = reserveStock(deps, reserveRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(stockReservations.list("tenant-a", "book-1")).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, reserveRequest, stockReservations } = reservationScene();
    reserveStock(deps, reserveRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      reserveStock(deps, reserveRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(stockReservations.list("tenant-a", "book-1")).toHaveLength(1);
  });

  it("예약을 해제하면 가용량이 돌아와 다른 주문이 그만큼 예약할 수 있다", () => {
    const { deps, reserveRequest, releaseRequest, w, reservation } = reservationReleaseScene(); // 보유 5, 예약 2
    const other = w.addOrder([{ bookId: "book-1", quantity: 4, unitPriceKrw: "15000" }]);
    const reserveOther = (quantity: number) => {
      try {
        reserveStock(
          deps,
          reserveRequest({ orderId: other.id, orderLineId: other.lines[0]!.lineId, quantity }),
        );
      } catch (error) {
        return error;
      }
    };

    expect(reserveOther(4)).toBeInstanceOf(AppError); // 가용 3 < 4
    expect(reserveOther(3)).toBeUndefined(); // 가용 0
    expect(reserveOther(1)).toBeInstanceOf(AppError);

    releaseStockReservation(deps, releaseRequest({ reservationId: reservation.id, quantity: 2 })); // 가용 2

    expect(reserveOther(1)).toBeUndefined(); // 품목 한도 4 중 4번째 권
  });

  it("예약을 해제하면 같은 주문 품목의 미배정량도 되살아나 다시 예약할 수 있다", () => {
    const { deps, reserveRequest, releaseRequest, reservation, stockReservations } =
      reservationReleaseScene(); // 품목 2권을 전부 예약한 상태
    const again = () => {
      try {
        reserveStock(deps, reserveRequest({ quantity: 1 }));
      } catch (error) {
        return error;
      }
    };

    expect(again()).toBeInstanceOf(AppError); // 품목 2권이 이미 예약됨

    releaseStockReservation(deps, releaseRequest({ reservationId: reservation.id, quantity: 1 }));

    expect(again()).toBeUndefined();
    expect(stockReservations.list("tenant-a", "book-1")).toHaveLength(2);
  });

  it("예약을 인도해도 가용량은 그대로라(보유와 예약이 함께 감소) 다른 주문이 남은 가용량만큼 예약할 수 있다", () => {
    const { deps, reserveRequest, deliverRequest, w } = reservationDeliveryScene(); // 보유 5, 예약 2
    deliverStockReservation(deps, deliverRequest({ quantity: 2 })); // 보유 3, 예약 0
    const other = w.addOrder([{ bookId: "book-1", quantity: 4, unitPriceKrw: "15000" }]);
    const reserveOther = (quantity: number) => {
      try {
        reserveStock(
          deps,
          reserveRequest({ orderId: other.id, orderLineId: other.lines[0]!.lineId, quantity }),
        );
      } catch (error) {
        return error;
      }
    };

    expect(reserveOther(4)).toBeInstanceOf(AppError); // 가용 3
    expect(reserveOther(3)).toBeUndefined();
    expect(reserveOther(1)).toBeInstanceOf(AppError); // 가용 0
  });

  it("이미 인도한 수량은 같은 주문 품목에 다시 예약할 수 없다 (Need=E-F-R, 누적 확보 유지)", () => {
    const { deps, reserveRequest, deliverRequest, stockReservations } = reservationDeliveryScene(); // 품목 2권
    deliverStockReservation(deps, deliverRequest({ quantity: 2 })); // 전량 인도

    let thrown: unknown;
    try {
      reserveStock(deps, reserveRequest({ quantity: 1 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(stockReservations.list("tenant-a", "book-1")).toHaveLength(1);
  });
});
