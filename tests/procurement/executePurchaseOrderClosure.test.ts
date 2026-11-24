import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { transferCancelledToStock } from "../../src/inventory/transferCancelledToStock";
import { decideExcessReceipt } from "../../src/inventory/decideExcessReceipt";
import { receiveGoods } from "../../src/inventory/receiveGoods";
import { createCancellationRequest } from "../../src/procurement/createCancellationRequest";
import { respondToCancellationRequest } from "../../src/procurement/respondToCancellationRequest";
import { executePurchaseOrderClosure } from "../../src/procurement/executePurchaseOrderClosure";
import { cancellationScene, createInMemoryExcessDecisionRepository, intakeScene } from "../helpers/inventoryFixtures";
import {
  createInMemoryReturnCompletionRepository,
  createInMemoryReturnExceptionRepository,
  createInMemoryReturnExceptionResolutionRepository,
  createInMemoryReturnReplyRepository,
  createInMemoryReturnRequestRepository,
  createInMemoryStockIntakeRepository,
} from "../helpers/inventoryFixtures";

/** 6권 발주(SENT)에 4권 정상 입고·주문 B 3권 배분이 있는 세계에 종결 판정용 저장소를 붙인다 */
function closureScene<T extends ReturnType<typeof cancellationScene>>(
  base: T = cancellationScene() as T,
) {
  const s = base;
  const deps = {
    stockIntakes: createInMemoryStockIntakeRepository(),
    returnRequests: createInMemoryReturnRequestRepository(),
    returnReplies: createInMemoryReturnReplyRepository(),
    returnExceptions: createInMemoryReturnExceptionRepository(),
    returnExceptionResolutions: createInMemoryReturnExceptionResolutionRepository(),
    ...s.deps,
    excessDecisions: createInMemoryExcessDecisionRepository(),
    returnCompletions: createInMemoryReturnCompletionRepository(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  /** 남은 정상 수량(6-4=2권)을 입고한다 */
  const receiveRest = () =>
    receiveGoods(deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      poLineId: s.poLineId,
      normalQuantity: 2,
      damagedQuantity: 0,
      misdeliveredQuantity: 0,
      inspectedBy: "김검수",
      receivedAt: "2026-03-04T06:35:00.000Z",
      idempotencyKey: "recv-rest",
    });
  const closeRequest = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: s.sent.id,
    expectedVersion: s.sent.version,
    executedBy: "SYSTEM" as const,
    executedAt: "2026-03-04T06:59:00.000Z",
    idempotencyKey: `pcl-${++seq}`,
    ...extra,
  });
  return { ...s, deps, receiveRest, closeRequest };
}

describe("executePurchaseOrderClosure: 발주 종결 (ST-P11, BR-P06)", () => {
  it("모든 품목의 정상 입고와 공급처 확정 축소로 잔량이 0이면 서버가 발주를 CLOSED(version+1)로 종결한다", () => {
    const { deps, sent, receiveRest, closeRequest } = closureScene();
    receiveRest();

    const closed = executePurchaseOrderClosure(deps, closeRequest());

    expect(closed).toMatchObject({
      id: sent.id,
      status: "CLOSED",
      version: sent.version + 1,
      closedAt: "2026-03-04T06:59:00.000Z",
    });
    expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(closed);
  });

  it("실행 주체가 SYSTEM이 아니면 FORBIDDEN 403이고, 없는 발주는 NOT_FOUND, version이 다르면 VERSION_CONFLICT 409이며, SENT·ACKNOWLEDGED가 아니거나 이미 종결된 발주는 BUSINESS_INVARIANT 422이다", () => {
    const { deps, sent, receiveRest, closeRequest } = closureScene();
    receiveRest();
    const codeOf = (extra: Record<string, unknown>) => {
      try {
        executePurchaseOrderClosure(deps, closeRequest(extra) as never);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ executedBy: "점주" })).toBe("FORBIDDEN");
    expect(codeOf({ purchaseOrderId: "no-such" })).toBe("NOT_FOUND");
    expect(codeOf({ tenantId: "tenant-b" })).toBe("NOT_FOUND");
    expect(codeOf({ expectedVersion: sent.version + 1 })).toBe("VERSION_CONFLICT");
    expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");

    expect(codeOf({})).toBeUndefined();
    expect(codeOf({ expectedVersion: sent.version + 1 })).toBe("BUSINESS_INVARIANT"); // 이미 CLOSED
  });

  it("정상 입고가 모자라 미입고 잔량이 남은 발주는 종결을 거부하고(BUSINESS_INVARIANT 422, 사유 OPEN_QUANTITY) 발주는 변하지 않는다", () => {
    const { deps, sent, closeRequest } = closureScene(); // 6권 중 4권만 입고
    const before = structuredClone(deps.purchaseOrders.get("tenant-a", sent.id));

    let thrown: unknown;
    try {
      executePurchaseOrderClosure(deps, closeRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).detail).toContain("OPEN_QUANTITY");
    expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(before);
  });

  it("초과입고 수량에 Owner 결정이 모자라면 종결을 거부하고(EXCESS_UNDECIDED), 결정이 초과 수량을 덮으면 종결할 수 있다", () => {
    const { deps, sent, poLineId, closeRequest } = closureScene();
    const receipt = receiveGoods(deps, {
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId,
      normalQuantity: 5, // 남은 정상 2권 + 초과 3권
      damagedQuantity: 0,
      misdeliveredQuantity: 0,
      inspectedBy: "김검수",
      receivedAt: "2026-03-04T06:35:00.000Z",
      idempotencyKey: "recv-over",
    });
    expect(receipt.excessQuantity).toBe(3);
    const decide = (quantity: number, key: string) =>
      decideExcessReceipt(deps, {
        tenantId: "tenant-a",
        receiptId: receipt.id,
        decision: "APPROVED",
        quantity,
        reason: "공급처 증정분, 점주 승인",
        actorRole: "OWNER",
        decidedBy: "점주",
        decidedAt: "2026-03-04T06:45:00.000Z",
        idempotencyKey: key,
      });
    const detailOf = () => {
      try {
        executePurchaseOrderClosure(deps, closeRequest());
      } catch (error) {
        return (error as AppError).detail;
      }
    };

    expect(detailOf()).toContain("EXCESS_UNDECIDED");
    decide(2, "exc-a");
    expect(detailOf()).toContain("EXCESS_UNDECIDED"); // 1권 미결정
    decide(1, "exc-b");
    expect(detailOf()).toBeUndefined();
    expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("CLOSED");
  });

  it("주문 취소로 해제된 입고 배분의 처분(재고 편입·반품)이 끝나지 않았으면 종결을 거부하고(DISPOSITION_OPEN), 처분이 끝나면 종결할 수 있다", () => {
    const scene = intakeScene(); // 주문 B 배분 3권 중 2권이 취소되어 처분 대기
    const { deps, receiveRest, closeRequest } = closureScene(scene);
    const { intakeRequest } = scene;
    receiveRest();
    const detailOf = () => {
      try {
        executePurchaseOrderClosure(deps, closeRequest());
      } catch (error) {
        return (error as AppError).detail;
      }
    };

    expect(detailOf()).toContain("DISPOSITION_OPEN");
    transferCancelledToStock(deps, intakeRequest({ quantity: 1 }));
    expect(detailOf()).toContain("DISPOSITION_OPEN"); // 1권 남음
    transferCancelledToStock(deps, intakeRequest({ quantity: 1 }));
    expect(detailOf()).toBeUndefined();
  });

  it("공급처가 일부만 응답한 취소 요청이 남아 있으면 종결을 거부하고(CANCELLATION_REQUEST_OPEN), 응답이 끝나면 종결할 수 있다 (BR-P02)", () => {
    const { deps, sent, poLineId, closeRequest } = closureScene(); // 6권 중 4권 입고
    const request = createCancellationRequest(deps, {
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId,
      quantity: 3,
      reason: "고객 취소로 3권 축소 요청",
      idempotencyKey: "cr-1",
    });
    const respond = (acceptedQuantity: number, rejectedQuantity: number, key: string) =>
      respondToCancellationRequest(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        cancellationRequestId: request.id,
        acceptedQuantity,
        rejectedQuantity,
        evidence: "공급처 회신 메일",
        repliedAt: "2026-03-04T06:40:00.000Z",
        idempotencyKey: key,
      });
    const detailOf = () => {
      try {
        executePurchaseOrderClosure(deps, closeRequest());
      } catch (error) {
        return (error as AppError).detail;
      }
    };

    respond(2, 0, "cr-resp-1"); // 유효 발주량 4 = 입고 4, 미응답 1권
    expect(detailOf()).toContain("CANCELLATION_REQUEST_OPEN");
    expect(detailOf()).not.toContain("OPEN_QUANTITY");
    respond(0, 1, "cr-resp-2");
    expect(detailOf()).toBeUndefined();
  });
});
