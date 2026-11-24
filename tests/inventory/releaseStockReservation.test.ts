import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { deliverStockReservation } from "../../src/inventory/deliverStockReservation";
import { releaseStockReservation } from "../../src/inventory/releaseStockReservation";
import { reservationDeliveryScene, reservationReleaseScene } from "../helpers/stockFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("releaseStockReservation: 주문 재고 예약 해제 (ST-I04, UC-27, BR-Q03/Q16)", () => {
  it("예약 일부를 해제하면 별도 해제 기록이 남고 원 예약과 재고 원장은 바뀌지 않는다 (보유 불변)", () => {
    const { deps, releaseRequest, reservation, stockMovements, stockReservations } =
      reservationReleaseScene();
    const reservationBefore = structuredClone(stockReservations.get("tenant-a", reservation.id));
    const movementsBefore = structuredClone(stockMovements.list("tenant-a", "book-1"));

    const release = releaseStockReservation(deps, releaseRequest({ quantity: 1 }));

    expect(release).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      reservationId: reservation.id,
      quantity: 1,
      reason: "고객이 수량 1권 줄임",
      releasedBy: "김직원",
      releasedAt: "2026-03-04T06:50:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toEqual([release]);
    expect(stockReservations.get("tenant-a", reservation.id)).toEqual(reservationBefore);
    expect(stockMovements.list("tenant-a", "book-1")).toEqual(movementsBefore);
  });

  it("해제 합계가 예약 수량(2)을 넘으면 BUSINESS_INVARIANT 422이고, 기존 해제를 합산한다", () => {
    const { deps, releaseRequest, reservation } = reservationReleaseScene();
    const release = (quantity: number) => {
      try {
        releaseStockReservation(deps, releaseRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = release(3);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(release(1)).toBeUndefined(); // 잔량 1
    expect(release(2)).toBeInstanceOf(AppError); // 1 초과
    expect(release(1)).toBeUndefined(); // 잔량 0 (CLOSED)
    expect(release(1)).toBeInstanceOf(AppError);
    expect(
      deps.stockReservationReleases.list("tenant-a", reservation.id).map((r) => r.quantity),
    ).toEqual([1, 1]);
  });

  it("수량이 1 이상 정수가 아니거나 사유·담당자가 비었거나 releasedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, releaseRequest, reservation } = reservationReleaseScene();

    for (const bad of [
      releaseRequest({ quantity: 0 }),
      releaseRequest({ quantity: -1 }),
      releaseRequest({ quantity: 1.5 }),
      releaseRequest({ quantity: Number.NaN }),
      releaseRequest({ reason: " " }),
      releaseRequest({ releasedBy: "" }),
      releaseRequest({ releasedAt: "2026-03-04" }),
      releaseRequest({ releasedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        releaseStockReservation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toEqual([]);
  });

  it("없는 예약이거나 다른 테넌트의 예약이면 NOT_FOUND 404이다", () => {
    const { deps, releaseRequest, reservation } = reservationReleaseScene();

    for (const bad of [
      releaseRequest({ reservationId: "no-such-reservation" }),
      releaseRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        releaseStockReservation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 해제를 돌려주고 중복 해제하지 않는다", () => {
    const { deps, releaseRequest, reservation } = reservationReleaseScene();

    const first = releaseStockReservation(deps, releaseRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = releaseStockReservation(deps, releaseRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, releaseRequest, reservation } = reservationReleaseScene();
    releaseStockReservation(deps, releaseRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      releaseStockReservation(deps, releaseRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toHaveLength(1);
  });

  it("이미 인도한 수량은 해제할 수 없고 미인도 잔량만 해제할 수 있다", () => {
    const { deps, deliverRequest, releaseRequest } = reservationDeliveryScene(); // 예약 2
    deliverStockReservation(deps, deliverRequest({ quantity: 1 })); // 인도 1 -> 미인도 1

    let thrown: unknown;
    try {
      releaseStockReservation(deps, releaseRequest({ quantity: 2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(releaseStockReservation(deps, releaseRequest({ quantity: 1 })).quantity).toBe(1);
  });
});
