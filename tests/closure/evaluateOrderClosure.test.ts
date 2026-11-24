import { describe, it, expect } from "vitest";
import { evaluateOrderClosure } from "../../src/order/evaluateOrderClosure";
import { cancelAllocation } from "../../src/inventory/cancelAllocation";
import { transferCancelledToStock } from "../../src/inventory/transferCancelledToStock";
import { confirmRefund } from "../../src/payment/confirmRefund";
import { openRefundTask } from "../../src/payment/openRefundTask";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { closureScene } from "../helpers/closureFixtures";

describe("evaluateOrderClosure: 종결 가능 여부 판정 (ST-O07, BR-O01/O03, DEC-10)", () => {
  it("전량 인도·잔액 0·미해결 업무 없음이면 종결 가능하고, 아니면 차단 사유 코드를 모두 낸다 (안내는 조건이 아니다)", () => {
    const { deps, orderD, pay, fulfillRequest, reservation } = closureScene(); // 주문 D 2권, 결제·인도 전

    expect(evaluateOrderClosure(deps, "tenant-a", orderD)).toEqual({
      closable: false,
      blockers: ["UNDELIVERED", "UNPAID_BALANCE"],
    });

    pay(orderD.id, "30000");
    postFulfillment(
      deps,
      fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 2 }] }),
    );

    expect(evaluateOrderClosure(deps, "tenant-a", orderD)).toEqual({ closable: true, blockers: [] });
  });

  it("미확인 결제가 남았거나 과수납 환급이 필요·진행 중이면 잔액이 0이어도 종결할 수 없고, 환급이 끝나야 종결할 수 있다", () => {
    const { deps, orderD, pay, fulfillRequest, reservation } = closureScene();
    pay(orderD.id, "30000");
    postFulfillment(
      deps,
      fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 2 }] }),
    );
    expect(evaluateOrderClosure(deps, "tenant-a", orderD).blockers).toEqual([]);

    const pending = pay(orderD.id, "5000", false); // 입력만 되고 확인되지 않은 거래
    expect(evaluateOrderClosure(deps, "tenant-a", orderD).blockers).toEqual(["PAYMENT_PENDING_VERIFICATION"]);

    const confirmed = pay(orderD.id, "4000"); // 확인된 과수납 4,000 (대기 건은 그대로)
    expect(evaluateOrderClosure(deps, "tenant-a", orderD).blockers).toEqual([
      "PAYMENT_PENDING_VERIFICATION",
      "REFUND_REQUIRED",
    ]);
    void pending;

    const task = openRefundTask(deps, {
      tenantId: "tenant-a",
      orderId: orderD.id,
      openedBy: "김직원",
      openedAt: "2026-03-04T06:45:00.000Z",
      idempotencyKey: "rft-closure",
    });
    expect(evaluateOrderClosure(deps, "tenant-a", orderD).blockers).toEqual([
      "PAYMENT_PENDING_VERIFICATION",
      "REFUND_OPEN",
    ]);

    confirmRefund(deps, {
      tenantId: "tenant-a",
      refundTaskId: task.id,
      paymentId: confirmed.id,
      amountKrw: "4000",
      evidence: "은행 환불 이체 내역",
      actorRole: "OWNER",
      confirmedBy: "점주",
      confirmedAt: "2026-03-04T06:50:00.000Z",
      idempotencyKey: "rfc-closure",
    });
    expect(evaluateOrderClosure(deps, "tenant-a", orderD).blockers).toEqual(["PAYMENT_PENDING_VERIFICATION"]);
  });

  it("주문의 입고 배분이 취소되어 처분 대기·반품 진행 중이면 종결할 수 없고, 재고 편입 등으로 처분이 끝나야 풀린다", () => {
    const { deps, orders, allocation, pay } = closureScene(); // 주문 B: 3권 입고 배분
    const orderB = orders[1]!;
    pay(orderB.id, "45000");
    const cancellation = cancelAllocation(deps, {
      tenantId: "tenant-a",
      allocationId: allocation.id,
      quantity: 3,
      reason: "고객 B 주문 전량 취소",
      actorRole: "OWNER",
      cancelledBy: "점주",
      cancelledAt: "2026-03-04T06:52:00.000Z",
      idempotencyKey: "can-closure",
    });
    const blockers = () => evaluateOrderClosure(deps, "tenant-a", orderB).blockers;

    expect(blockers()).toContain("DISPOSITION_OPEN");

    transferCancelledToStock(deps, {
      tenantId: "tenant-a",
      cancellationId: cancellation.id,
      quantity: 2,
      actorRole: "OWNER",
      actedBy: "점주",
      actedAt: "2026-03-04T06:58:00.000Z",
      idempotencyKey: "int-closure-1",
    });
    expect(blockers()).toContain("DISPOSITION_OPEN"); // 1권이 아직 처분 대기

    transferCancelledToStock(deps, {
      tenantId: "tenant-a",
      cancellationId: cancellation.id,
      quantity: 1,
      actorRole: "OWNER",
      actedBy: "점주",
      actedAt: "2026-03-04T06:58:30.000Z",
      idempotencyKey: "int-closure-2",
    });
    expect(blockers()).not.toContain("DISPOSITION_OPEN");
  });
});
