import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { transferCancelledToStock } from "../../src/inventory/transferCancelledToStock";
import { requestReturn } from "../../src/inventory/requestReturn";
import { cancelAllocation } from "../../src/inventory/cancelAllocation";
import { resolveReturnException } from "../../src/inventory/resolveReturnException";
import { recordReturnReply } from "../../src/inventory/recordReturnReply";
import { cancellationScene, intakeScene, resolutionScene, returnReplyScene, returnScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("transferCancelledToStock: 취소 도서 매장 재고 편입 (ST-C06, UC-28, DEC-18, BR-Q15)", () => {
  it("Owner가 처분 대기 물량을 재고로 편입하면 편입 기록과 재고 증가 원장(CANCEL_TO_STOCK)이 함께 남는다", () => {
    const { deps, intakeRequest, cancellation, stockMovements } = intakeScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    const result = transferCancelledToStock(deps, intakeRequest({ quantity: 1 }));

    expect(result.intake).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      cancellationId: cancellation.id,
      receiptId: cancellation.receiptId,
      orderId: cancellation.orderId,
      orderLineId: cancellation.orderLineId,
      quantity: 1,
      actedBy: "점주",
      actedAt: "2026-03-04T06:58:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(result.movement).toMatchObject({
      kind: "CANCEL_TO_STOCK",
      direction: "IN",
      quantity: 1,
      bookId: "book-1",
      cancellationId: cancellation.id,
      actedBy: "점주",
    });
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toEqual([result.intake]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before + 1);
    expect(stockMovements.list("tenant-a", "book-1").at(-1)).toEqual(result.movement);
  });

  it("편입 합계가 처분 대기 수량(2)을 넘으면 BUSINESS_INVARIANT 422이고(중복 편입 금지) 재고 원장도 늘지 않는다", () => {
    const { deps, intakeRequest, cancellation, stockMovements } = intakeScene();
    const count = () => stockMovements.list("tenant-a", "book-1").length;
    const before = count();
    const intake = (quantity: number) => {
      try {
        transferCancelledToStock(deps, intakeRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = intake(3);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(count()).toBe(before);

    expect(intake(1)).toBeUndefined(); // 처분 대기 잔량 1
    expect(intake(2)).toBeInstanceOf(AppError); // 1 초과
    expect(intake(1)).toBeUndefined(); // 잔량 0
    expect(intake(1)).toBeInstanceOf(AppError); // 같은 물량을 다시 편입할 수 없다
    expect(count()).toBe(before + 2);
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toHaveLength(2);
  });

  it("STAFF는 재고 편입을 결정할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, intakeRequest, cancellation, stockMovements } = intakeScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    let thrown: unknown;
    try {
      transferCancelledToStock(deps, intakeRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toEqual([]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before);
  });

  it("수량이 1 이상 정수가 아니거나 담당자가 비었거나 actedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, intakeRequest, cancellation, stockMovements } = intakeScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    for (const bad of [
      intakeRequest({ quantity: 0 }),
      intakeRequest({ quantity: -1 }),
      intakeRequest({ quantity: 1.5 }),
      intakeRequest({ quantity: Number.NaN }),
      intakeRequest({ actedBy: " " }),
      intakeRequest({ actedAt: "2026-03-04" }),
      intakeRequest({ actedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        transferCancelledToStock(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toEqual([]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before);
  });

  it("없는 취소 처분이거나 다른 테넌트의 처분이면 NOT_FOUND 404이고 아무것도 기록되지 않는다", () => {
    const { deps, intakeRequest, cancellation, stockMovements } = intakeScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    for (const bad of [
      intakeRequest({ cancellationId: "no-such-cancellation" }),
      intakeRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        transferCancelledToStock(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toEqual([]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before);
  });

  it("매장 재고가 초기 등록되지 않은 도서는 편입할 수 없고(BUSINESS_INVARIANT 422) 처분 대기는 그대로 남는다", () => {
    const base = cancellationScene(); // 재고 원장이 비어 있는 세계
    const stockMovements = {
      all: [] as unknown[],
      list: () => [] as never[],
      save(m: unknown) {
        this.all.push(m);
      },
    };
    const deps = {
      ...base.deps,
      stockMovements,
      stockIntakes: { list: () => [] as never[], save() {} },
      returnRequests: { list: () => [] as never[] },
      returnReplies: { list: () => [] as never[] },
      returnExceptions: { list: () => [] as never[] },
      returnExceptionResolutions: { list: () => [] as never[] },
    };
    const cancellation = cancelAllocation(deps, base.cancelRequest({ quantity: 2 }));

    let thrown: unknown;
    try {
      transferCancelledToStock(deps, {
        tenantId: "tenant-a",
        cancellationId: cancellation.id,
        quantity: 1,
        actorRole: "OWNER",
        actedBy: "점주",
        actedAt: "2026-03-04T06:58:00.000Z",
        idempotencyKey: "int-x",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(stockMovements.all).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 결과를 돌려주고 재고를 중복 증가시키지 않는다", () => {
    const { deps, intakeRequest, cancellation, stockMovements } = intakeScene();
    const before = stockMovements.list("tenant-a", "book-1").length;

    const first = transferCancelledToStock(deps, intakeRequest({ quantity: 1, idempotencyKey: "k" }));
    const replay = transferCancelledToStock(deps, intakeRequest({ quantity: 1, idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toEqual([first.intake]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before + 1);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, intakeRequest, cancellation } = intakeScene();
    transferCancelledToStock(deps, intakeRequest({ quantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      transferCancelledToStock(deps, intakeRequest({ quantity: 2, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toHaveLength(1);
  });

  it("반품을 요청한 수량은 재고로 편입할 수 없고, 반품 요청이 없는 나머지만 편입할 수 있다 (반품과 편입은 배타)", () => {
    const { deps, returnRequest, transferRequest } = returnScene(); // 처분 대기 2
    requestReturn(deps, returnRequest({ quantity: 1 })); // 1권은 반품 요청 중

    let thrown: unknown;
    try {
      transferCancelledToStock(deps, transferRequest({ quantity: 2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(transferCancelledToStock(deps, transferRequest({ quantity: 1 })).intake.quantity).toBe(1);
  });

  it("공급처가 거절한 반품 수량은 처분 대기로 돌아와 재고로 편입할 수 있다 (REJECTED -> STOCKED)", () => {
    const { deps, replyRequest, transferRequest } = returnReplyScene(); // 반품 요청 2(처분 대기 0)
    const intake = (quantity: number) => {
      try {
        transferCancelledToStock(deps, transferRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    expect(intake(1)).toBeInstanceOf(AppError); // 반품 요청 중
    recordReturnReply(deps, replyRequest({ acceptedQuantity: 1, rejectedQuantity: 1 })); // 거절 1

    expect(intake(2)).toBeInstanceOf(AppError); // 처분 대기는 거절된 1뿐
    expect(intake(1)).toBeUndefined();
    expect(intake(1)).toBeInstanceOf(AppError);
  });

  it("출고 후 반송·분실로 신고됐지만 아직 회수되지 않은 수량은 재고로 편입할 수 없다 (미회수 편입 금지)", () => {
    const { deps, transferRequest, cancellation, stockMovements } = resolutionScene(); // 요청 2, 출고·반송 1(미회수)
    const before = stockMovements.list("tenant-a", "book-1").length;

    let thrown: unknown;
    try {
      transferCancelledToStock(deps, transferRequest({ quantity: 1 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.stockIntakes.list("tenant-a", cancellation.id)).toEqual([]);
    expect(stockMovements.list("tenant-a", "book-1")).toHaveLength(before);
  });

  it("실물 회수·검수 확인된(RECOVERED) 수량만 처분 대기로 돌아와 재고로 편입할 수 있다", () => {
    const { deps, transferRequest, resolveRequest } = resolutionScene(); // 출고·반송 1(미회수)
    const intake = (quantity: number) => {
      try {
        transferCancelledToStock(deps, transferRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    expect(intake(1)).toBeInstanceOf(AppError); // 미회수
    resolveReturnException(deps, resolveRequest({ outcome: "RECOVERED", quantity: 1 }));

    expect(intake(2)).toBeInstanceOf(AppError); // 회수된 1뿐
    expect(intake(1)).toBeUndefined();
    expect(intake(1)).toBeInstanceOf(AppError);
  });
});
