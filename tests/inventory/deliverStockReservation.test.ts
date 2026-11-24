import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { releaseStockReservation } from "../../src/inventory/releaseStockReservation";
import { deliverStockReservation } from "../../src/inventory/deliverStockReservation";
import { reservationDeliveryScene } from "../helpers/stockFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("deliverStockReservation: 예약 인도 (ST-I05, UC-27, BR-Q03/Q09)", () => {
  it("예약 일부를 인도하면 인도 기록과 보유 감소 원장(DELIVERY/OUT)이 함께 남고 원 예약은 바뀌지 않는다", () => {
    const { deps, deliverRequest, reservation, stockMovements, stockReservations } =
      reservationDeliveryScene();
    const reservationBefore = structuredClone(stockReservations.get("tenant-a", reservation.id));

    const result = deliverStockReservation(deps, deliverRequest({ quantity: 1 }));

    expect(result.delivery).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      reservationId: reservation.id,
      quantity: 1,
      deliveredBy: "김직원",
      deliveredAt: "2026-03-04T06:55:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(result.movement).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      kind: "DELIVERY",
      direction: "OUT",
      quantity: 1,
      reason: "예약 인도",
      reservationId: reservation.id,
      actedBy: "김직원",
      actedAt: "2026-03-04T06:55:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([
      result.delivery,
    ]);
    expect(stockMovements.list("tenant-a", "book-1").at(-1)).toEqual(result.movement);
    expect(stockReservations.get("tenant-a", reservation.id)).toEqual(reservationBefore);
  });

  it("인도 합계가 잔량(예약-해제-기인도)을 넘으면 BUSINESS_INVARIANT 422이고 인도 기록도 재고 원장도 남지 않는다", () => {
    const { deps, deliverRequest, releaseRequest, reservation, stockMovements } =
      reservationDeliveryScene(); // 예약 2
    releaseStockReservation(deps, releaseRequest({ reservationId: reservation.id, quantity: 1 })); // 잔량 1
    const movementCount = () => stockMovements.list("tenant-a", "book-1").length;
    const before = movementCount();
    const deliver = (quantity: number) => {
      try {
        deliverStockReservation(deps, deliverRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = deliver(2);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(movementCount()).toBe(before);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([]);

    expect(deliver(1)).toBeUndefined(); // 잔량 0
    expect(deliver(1)).toBeInstanceOf(AppError);
    expect(movementCount()).toBe(before + 1);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toHaveLength(1);
  });

  it("수량이 1 이상 정수가 아니거나 담당자가 비었거나 deliveredAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, deliverRequest, reservation, stockMovements } = reservationDeliveryScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    for (const bad of [
      deliverRequest({ quantity: 0 }),
      deliverRequest({ quantity: -1 }),
      deliverRequest({ quantity: 1.5 }),
      deliverRequest({ quantity: Number.NaN }),
      deliverRequest({ deliveredBy: " " }),
      deliverRequest({ deliveredAt: "2026-03-04" }),
      deliverRequest({ deliveredAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        deliverStockReservation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before);
  });

  it("없는 예약이거나 다른 테넌트의 예약이면 NOT_FOUND 404이고 아무것도 기록되지 않는다", () => {
    const { deps, deliverRequest, reservation, stockMovements } = reservationDeliveryScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    for (const bad of [
      deliverRequest({ reservationId: "no-such-reservation" }),
      deliverRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        deliverStockReservation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before);
  });

  it("같은 멱등 키로 재호출하면 같은 결과를 돌려주고 보유를 중복 감소시키지 않는다", () => {
    const { deps, deliverRequest, reservation, stockMovements } = reservationDeliveryScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    const first = deliverStockReservation(deps, deliverRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = deliverStockReservation(deps, deliverRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([first.delivery]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before + 1);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, deliverRequest, reservation } = reservationDeliveryScene();
    deliverStockReservation(deps, deliverRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      deliverStockReservation(deps, deliverRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toHaveLength(1);
  });
});
