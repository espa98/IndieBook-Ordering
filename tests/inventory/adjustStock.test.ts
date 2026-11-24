import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { adjustStock } from "../../src/inventory/adjustStock";
import { adjustScene } from "../helpers/stockFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("adjustStock: 재고 증감 조정 (ST-I02, UC-26, BR-Q09/Q22, DEC-19)", () => {
  it("Owner가 사유와 함께 재고를 늘리면 ADJUST 수불 원장이 추가되고 기존 원장은 바뀌지 않는다", () => {
    const { deps, adjustRequest, stockMovements } = adjustScene();
    const before = structuredClone(stockMovements.list("tenant-a", "book-1"));

    const movement = adjustStock(deps, adjustRequest({ direction: "IN", quantity: 3 }));

    expect(movement).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      kind: "ADJUST",
      direction: "IN",
      quantity: 3,
      reason: "실사 결과 3권 추가 발견",
      actedBy: "점주",
      actedAt: "2026-03-04T06:30:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(stockMovements.list("tenant-a", "book-1")).toEqual([...before, movement]);
  });

  it("감소 조정이 보유 수량을 음수로 만들면 BUSINESS_INVARIANT 422이고 기존 조정을 합산한다", () => {
    const { deps, adjustRequest, stockMovements } = adjustScene(); // 보유 5
    const out = (quantity: number) => {
      try {
        adjustStock(deps, adjustRequest({ direction: "OUT", quantity, reason: "파손 폐기" }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = out(6);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(out(3)).toBeUndefined(); // 보유 2
    expect(out(3)).toBeInstanceOf(AppError); // 2 < 3
    expect(out(2)).toBeUndefined(); // 보유 0
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(3);
  });

  it("감소 조정이 예약량보다 작은 보유 수량을 만들면 BUSINESS_INVARIANT 422이다 (on_hand >= reserved)", () => {
    const { deps, adjustRequest, stockReservations, stockMovements } = adjustScene(); // 보유 5
    stockReservations.save({
      id: "res-1",
      tenantId: "tenant-a",
      bookId: "book-1",
      orderId: "order-1",
      orderLineId: "line-1",
      quantity: 4,
    }); // 예약 4 -> 가용 1

    let thrown: unknown;
    try {
      adjustStock(deps, adjustRequest({ direction: "OUT", quantity: 2, reason: "분실" })); // 보유 3 < 예약 4
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(1);
    expect(
      adjustStock(deps, adjustRequest({ direction: "OUT", quantity: 1, reason: "분실" })).quantity,
    ).toBe(1); // 보유 4 = 예약 4
  });

  it("점주가 위임하지 않은 STAFF는 재고를 조정할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, adjustRequest, stockMovements } = adjustScene();

    let thrown: unknown;
    try {
      adjustStock(deps, adjustRequest({ actorRole: "STAFF", actedBy: "김직원" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(1);
  });

  it("점주가 명시적으로 위임한 STAFF는 재고를 조정할 수 있다", () => {
    const { deps, adjustRequest, stockDelegations, stockMovements } = adjustScene();
    stockDelegations.grant("tenant-a", "김직원");

    const movement = adjustStock(deps, adjustRequest({ actorRole: "STAFF", actedBy: "김직원" }));

    expect(movement.actedBy).toBe("김직원");
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(2);
    // 위임은 서점별이다: 다른 서점에서는 여전히 조정 불가
    expect(deps.stockDelegations.isDelegated("tenant-b", "김직원")).toBe(false);
  });

  it("사유·담당자가 비었거나 방향·수량·actedAt이 잘못이면 VALIDATION_ERROR 400이다", () => {
    const { deps, adjustRequest, stockMovements } = adjustScene(); // now = 2026-03-04T07:00Z

    for (const bad of [
      adjustRequest({ reason: " " }),
      adjustRequest({ actedBy: "" }),
      adjustRequest({ direction: "SIDEWAYS" as never }),
      adjustRequest({ quantity: 0 }),
      adjustRequest({ quantity: -1 }),
      adjustRequest({ quantity: 1.5 }),
      adjustRequest({ quantity: Number.NaN }),
      adjustRequest({ actedAt: "2026-03-04" }),
      adjustRequest({ actedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        adjustStock(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(1);
  });

  it("초기 재고가 등록되지 않은 도서(또는 다른 서점)는 조정할 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const { deps, adjustRequest, stockMovements } = adjustScene();

    for (const bad of [
      adjustRequest({ bookId: "book-unregistered" }),
      adjustRequest({ tenantId: "tenant-b" }), // book-1은 tenant-a에만 등록됨
    ]) {
      let thrown: unknown;
      try {
        adjustStock(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    }
    expect(stockMovements.list("tenant-a", "book-unregistered")).toEqual([]);
    expect(stockMovements.list("tenant-b", "book-1")).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 조정을 돌려주고 중복 반영하지 않는다", () => {
    const { deps, adjustRequest, stockMovements } = adjustScene();

    const first = adjustStock(deps, adjustRequest({ quantity: 2, idempotencyKey: "k" }));
    const replay = adjustStock(deps, adjustRequest({ quantity: 2, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(2); // INITIAL + ADJUST 1건
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, adjustRequest, stockMovements } = adjustScene();
    adjustStock(deps, adjustRequest({ quantity: 2, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      adjustStock(deps, adjustRequest({ quantity: 3, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(2);
  });
});
