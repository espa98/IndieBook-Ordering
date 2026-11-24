import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { executeOrderReopening } from "../../src/order/executeOrderReopening";
import { recordPayment } from "../../src/payment/recordPayment";
import { reopeningScene } from "../helpers/closureFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("executeOrderReopening: 종결 후 승인 정정에 따른 재개 (ST-O10, D21, BR-O07)", () => {
  it("종결 후 Owner 승인 정정(결제 보정)으로 종결 조건이 깨지면 서버가 주문을 재개하고(closedAt 제거, version+1) 재개 기록이 남으며, 다시 신규 거래를 받을 수 있다", () => {
    const { deps, correctOrderPayment, reopenRequest, orderD, orderReopenings } = reopeningScene();
    const closed = deps.orders.get("tenant-a", orderD.id)!;
    expect(closed.closedAt).toBeDefined();
    const correction = correctOrderPayment("5000"); // 확인 25,000원 → 잔액 5,000원

    const reopening = executeOrderReopening(deps, reopenRequest(correction.id));

    expect(reopening).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: orderD.id,
      trigger: { kind: "PAYMENT_CORRECTION", id: correction.id },
      blockers: ["UNPAID_BALANCE"],
      orderVersionBefore: closed.version,
      orderVersionAfter: closed.version + 1,
      executedBy: "SYSTEM",
      reopenedAt: "2026-03-04T06:59:45.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(orderReopenings.list("tenant-a", orderD.id)).toEqual([reopening]);
    const reopened = deps.orders.get("tenant-a", orderD.id)!;
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.version).toBe(closed.version + 1);
    // 재개된 주문은 다시 결제를 받을 수 있다 (종결 중에는 거부됨)
    expect(() =>
      recordPayment(deps, {
        tenantId: "tenant-a",
        orderId: orderD.id,
        method: "CARD",
        amountKrw: "5000",
        externalReference: "AFTER-REOPEN",
        paidAt: "2026-03-04T06:00:00.000Z",
        recordedBy: "김직원",
        idempotencyKey: "pay-after-reopen",
      }),
    ).not.toThrow();
  });

  it("종결되지 않은 주문이거나 이미 재개된 주문은 재개 대상이 아니다 (BUSINESS_INVARIANT 422)", () => {
    const reopened = reopeningScene();
    const correction = reopened.correctOrderPayment("1");
    executeOrderReopening(reopened.deps, reopened.reopenRequest(correction.id)); // 첫 재개는 성공

    let again: unknown;
    try {
      executeOrderReopening(reopened.deps, reopened.reopenRequest(correction.id)); // 이미 재개됨
    } catch (error) {
      again = error;
    }

    expect(again).toBeInstanceOf(AppError);
    expect((again as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(reopened.orderReopenings.list("tenant-a", reopened.orderD.id)).toHaveLength(1);
  });

  it("정정 기록이 있어도 종결 조건이 그대로 충족되면 재개하지 않고 기존 종결 상태를 보존한다 (BR-O07)", () => {
    const { deps, orderD, paymentId, reopenRequest, orderReopenings } = reopeningScene();
    // 금액을 바꾸지 않는 정정 기록(0원)을 직접 넣어 '정정은 있으나 조건은 그대로'인 상황을 만든다
    deps.paymentCorrections.save({
      id: "corr-noop",
      tenantId: "tenant-a",
      orderId: orderD.id,
      paymentId,
      reducedKrw: "0",
      reason: "영향 없는 정정",
      evidence: "확인",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:59:30.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    const before = structuredClone(deps.orders.get("tenant-a", orderD.id));

    let thrown: unknown;
    try {
      executeOrderReopening(deps, reopenRequest("corr-noop"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(before);
    expect(orderReopenings.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("재개 근거가 되는 정정이 없거나 다른 주문의 정정이면 거부한다 (NOT_FOUND 404 / BUSINESS_INVARIANT 422)", () => {
    const { deps, orderD, reopenRequest, correctOrderPayment, orderReopenings } = reopeningScene();
    const correction = correctOrderPayment("5000");
    const codeOf = (request: ReturnType<typeof reopenRequest>) => {
      try {
        executeOrderReopening(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(reopenRequest("no-such-correction"))).toBe("NOT_FOUND");
    expect(codeOf(reopenRequest(correction.id, { tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(codeOf(reopenRequest(correction.id, { orderId: "no-such-order" }))).toBe("NOT_FOUND");
    // 다른 주문의 정정을 근거로 쓸 수 없다
    const other = deps.payments.list("tenant-a", orderD.id)[0]!;
    deps.paymentCorrections.save({ ...correction, id: "corr-other", orderId: "other-order", paymentId: other.id });
    expect(codeOf(reopenRequest("corr-other"))).toBe("BUSINESS_INVARIANT");
    expect(orderReopenings.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("실행 주체가 서버(SYSTEM)가 아니면 FORBIDDEN 403이고, executedAt이 잘못·미래이면 VALIDATION_ERROR 400이며 주문은 그대로다", () => {
    const { deps, orderD, correctOrderPayment, reopenRequest, orderReopenings } = reopeningScene();
    const correction = correctOrderPayment("5000");
    const before = structuredClone(deps.orders.get("tenant-a", orderD.id));
    const codeOf = (request: ReturnType<typeof reopenRequest>) => {
      try {
        executeOrderReopening(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(reopenRequest(correction.id, { executedBy: "김직원" as never }))).toBe("FORBIDDEN");
    expect(codeOf(reopenRequest(correction.id, { executedBy: "OWNER" as never }))).toBe("FORBIDDEN");
    expect(codeOf(reopenRequest(correction.id, { executedAt: "2026-03-04" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(reopenRequest(correction.id, { executedAt: "2026-03-04T08:00:00.000Z" }))).toBe("VALIDATION_ERROR");
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(before);
    expect(orderReopenings.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 재개 기록을 돌려주고(이미 재개됨 오류가 아니다) 주문 version을 다시 올리지 않는다", () => {
    const { deps, orderD, correctOrderPayment, reopenRequest, orderReopenings } = reopeningScene();
    const correction = correctOrderPayment("5000");
    const closedVersion = deps.orders.get("tenant-a", orderD.id)!.version;

    const first = executeOrderReopening(deps, reopenRequest(correction.id, { idempotencyKey: "k" }));
    const replay = executeOrderReopening(deps, reopenRequest(correction.id, { idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(orderReopenings.list("tenant-a", orderD.id)).toEqual([first]);
    expect(deps.orders.get("tenant-a", orderD.id)!.version).toBe(closedVersion + 1);
  });
});
