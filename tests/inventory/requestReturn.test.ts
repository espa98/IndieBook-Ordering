import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { transferCancelledToStock } from "../../src/inventory/transferCancelledToStock";
import { requestReturn } from "../../src/inventory/requestReturn";
import { returnScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("requestReturn: 취소 물량 공급처 반품 선택 (ST-C02, UC-28, DEC-18)", () => {
  it("Owner가 처분 대기 물량을 반품으로 선택하면 원 입고·공급처·수량을 참조하는 반품 요청이 남는다", () => {
    const { deps, returnRequest, cancellation } = returnScene(); // 처분 대기 2, 공급처 sup-a

    const request = requestReturn(deps, returnRequest({ quantity: 2 }));

    expect(request).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      cancellationId: cancellation.id,
      receiptId: cancellation.receiptId,
      supplierCode: "sup-a",
      quantity: 2,
      requestedBy: "점주",
      requestedAt: "2026-03-04T06:59:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toEqual([request]);
  });

  it("반품 요청은 처분 대기 잔량(취소 수량-재고 편입-기존 반품 요청)을 넘을 수 없다 (반품과 편입은 같은 물량에 배타)", () => {
    const { deps, returnRequest, transferRequest, cancellation } = returnScene(); // 처분 대기 2
    transferCancelledToStock(deps, transferRequest({ quantity: 1 })); // 1권은 이미 재고 편입
    const requestOf = (quantity: number) => {
      try {
        requestReturn(deps, returnRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = requestOf(2); // 잔량 1
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(requestOf(1)).toBeUndefined(); // 잔량 0
    expect(requestOf(1)).toBeInstanceOf(AppError);
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(1);
  });

  it("STAFF는 반품 경로를 선택할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, returnRequest, cancellation } = returnScene();

    let thrown: unknown;
    try {
      requestReturn(deps, returnRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toEqual([]);
  });

  it("수량이 1 이상 정수가 아니거나 담당자가 비었거나 requestedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, returnRequest, cancellation } = returnScene();

    for (const bad of [
      returnRequest({ quantity: 0 }),
      returnRequest({ quantity: -1 }),
      returnRequest({ quantity: 1.5 }),
      returnRequest({ quantity: Number.NaN }),
      returnRequest({ requestedBy: " " }),
      returnRequest({ requestedAt: "2026-03-04" }),
      returnRequest({ requestedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        requestReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toEqual([]);
  });

  it("없는 취소 처분이거나 다른 테넌트의 처분이면 NOT_FOUND 404이다", () => {
    const { deps, returnRequest, cancellation } = returnScene();

    for (const bad of [
      returnRequest({ cancellationId: "no-such-cancellation" }),
      returnRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        requestReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 반품 요청을 돌려주고 중복 요청하지 않는다", () => {
    const { deps, returnRequest, cancellation } = returnScene();

    const first = requestReturn(deps, returnRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = requestReturn(deps, returnRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, returnRequest, cancellation } = returnScene();
    requestReturn(deps, returnRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      requestReturn(deps, returnRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(1);
  });
});
