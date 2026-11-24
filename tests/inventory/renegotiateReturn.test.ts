import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { transferCancelledToStock } from "../../src/inventory/transferCancelledToStock";
import { renegotiateReturn } from "../../src/inventory/renegotiateReturn";
import { renegotiationScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("renegotiateReturn: 거절된 반품 재협의 (ST-C07, UC-28)", () => {
  it("거절된 수량을 재협의하면 원 요청을 보존한 채 재시도 근거를 가진 새 반품 요청이 생기고 Staff도 할 수 있다", () => {
    const { deps, renegotiateRequest, returnRequestRecord, cancellation } = renegotiationScene();
    const originalBefore = structuredClone(returnRequestRecord);

    const retry = renegotiateReturn(deps, renegotiateRequest({ quantity: 1 }));

    expect(retry).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      bookId: "book-1",
      cancellationId: cancellation.id,
      receiptId: cancellation.receiptId,
      supplierCode: "sup-a",
      quantity: 1,
      requestedBy: "김직원",
      requestedAt: "2026-03-04T06:59:40.000Z",
      retryOfRequestId: returnRequestRecord.id,
      retryReason: "공급처 담당자 변경, 재협의로 수락 가능성 확인",
      recordedAt: expect.any(String),
    });
    expect(deps.returnRequests.get("tenant-a", returnRequestRecord.id)).toEqual(originalBefore);
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(2);
  });

  it("재협의는 원 요청에서 거절된 수량(1)까지만 가능하고, 이미 재협의했거나 재고로 편입한 수량은 다시 요청할 수 없다", () => {
    const { deps, renegotiateRequest, transferRequest, cancellation } = renegotiationScene(); // 거절 1(처분 대기 1)
    const retry = (quantity: number) => {
      try {
        renegotiateReturn(deps, renegotiateRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = retry(2); // 거절은 1뿐
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(retry(1)).toBeUndefined(); // 재협의 1
    expect(retry(1)).toBeInstanceOf(AppError); // 거절분은 이미 재협의됨

    // 다른 요청: 거절분을 먼저 재고로 편입했다면 재협의할 수 없다
    const second = renegotiationScene();
    transferCancelledToStock(second.deps, second.transferRequest({ quantity: 1 }));
    expect(() => renegotiateReturn(second.deps, second.renegotiateRequest({ quantity: 1 }))).toThrow(AppError);
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(2);
    void transferRequest;
  });

  it("수량이 1 이상 정수가 아니거나 재시도 근거·담당자가 비었거나 requestedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, renegotiateRequest, cancellation } = renegotiationScene();

    for (const bad of [
      renegotiateRequest({ quantity: 0 }),
      renegotiateRequest({ quantity: 1.5 }),
      renegotiateRequest({ quantity: Number.NaN }),
      renegotiateRequest({ retryReason: " " }),
      renegotiateRequest({ requestedBy: "" }),
      renegotiateRequest({ requestedAt: "2026-03-04" }),
      renegotiateRequest({ requestedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        renegotiateReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(1);
  });

  it("없는 원 요청이거나 다른 테넌트의 요청이면 NOT_FOUND 404이다", () => {
    const { deps, renegotiateRequest, cancellation } = renegotiationScene();

    for (const bad of [
      renegotiateRequest({ originalRequestId: "no-such-request" }),
      renegotiateRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        renegotiateReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(1);
  });

  it("같은 멱등 키로 재호출하면 같은 재협의 요청을 돌려주고 중복 요청하지 않는다", () => {
    const { deps, renegotiateRequest, cancellation } = renegotiationScene();

    const first = renegotiateReturn(deps, renegotiateRequest({ idempotencyKey: "k" }));
    const replay = renegotiateReturn(deps, renegotiateRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(2);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, renegotiateRequest, cancellation } = renegotiationScene();
    renegotiateReturn(deps, renegotiateRequest({ retryReason: "근거 A", idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      renegotiateReturn(deps, renegotiateRequest({ retryReason: "근거 B", idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.returnRequests.list("tenant-a", cancellation.id)).toHaveLength(2);
  });
});
