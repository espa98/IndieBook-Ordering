import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { registerInitialStock } from "../../src/inventory/registerInitialStock";
import { stockScene } from "../helpers/stockFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("registerInitialStock: 초기 재고 등록 (ST-I01, UC-26, BR-Q22, DEC-19)", () => {
  it("Owner가 도서의 현재 보유 수량을 등록하면 INITIAL 수불 원장이 양수 수량과 방향으로 남는다", () => {
    const { deps, initialRequest, stockMovements } = stockScene();

    const movement = registerInitialStock(deps, initialRequest({ quantity: 5 }));

    expect(movement).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      kind: "INITIAL",
      direction: "IN",
      quantity: 5,
      reason: "초기 재고 등록",
      actedBy: "점주",
      actedAt: "2026-03-04T06:00:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(stockMovements.list("tenant-a", "book-1")).toEqual([movement]);
  });

  it("STAFF는 초기 재고를 등록할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, initialRequest, stockMovements } = stockScene();

    let thrown: unknown;
    try {
      registerInitialStock(deps, initialRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(stockMovements.list("tenant-a", "book-1")).toEqual([]);
  });

  it("도서·담당자가 비었거나 수량이 1 이상 정수가 아니거나 actedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, initialRequest, stockMovements } = stockScene(); // now = 2026-03-04T07:00Z

    for (const bad of [
      initialRequest({ bookId: " " }),
      initialRequest({ actedBy: "" }),
      initialRequest({ quantity: 0 }),
      initialRequest({ quantity: -1 }),
      initialRequest({ quantity: 1.5 }),
      initialRequest({ quantity: Number.NaN }),
      initialRequest({ actedAt: "2026-03-04" }),
      initialRequest({ actedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        registerInitialStock(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(stockMovements.list("tenant-a", "book-1")).toEqual([]);
  });

  it("같은 서점·도서의 초기 재고를 다시 등록하면 BUSINESS_INVARIANT 422이고, 다른 도서나 다른 서점은 등록할 수 있다", () => {
    const { deps, initialRequest, stockMovements } = stockScene();
    registerInitialStock(deps, initialRequest({ quantity: 5 }));

    let thrown: unknown;
    try {
      registerInitialStock(deps, initialRequest({ quantity: 7 })); // 다른 멱등 키, 같은 도서
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).httpStatus).toBe(422);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(1);

    registerInitialStock(deps, initialRequest({ bookId: "book-2" }));
    registerInitialStock(deps, initialRequest({ tenantId: "tenant-b" }));
    expect(stockMovements.list("tenant-a", "book-2")).toHaveLength(1);
    expect(stockMovements.list("tenant-b", "book-1")).toHaveLength(1);
  });

  it("같은 멱등 키로 재호출하면 같은 원장 항목을 돌려주고 중복 기록하지 않는다(중복 등록 오류도 아니다)", () => {
    const { deps, initialRequest, stockMovements } = stockScene();

    const first = registerInitialStock(deps, initialRequest({ idempotencyKey: "k" }));
    const replay = registerInitialStock(deps, initialRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(stockMovements.list("tenant-a", "book-1")).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, initialRequest, stockMovements } = stockScene();
    registerInitialStock(deps, initialRequest({ quantity: 5, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      registerInitialStock(deps, initialRequest({ quantity: 6, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(1);
  });
});
