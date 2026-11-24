import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { reserveStock } from "../../src/inventory/reserveStock";
import { requestOrderCancellation } from "../../src/order/requestOrderCancellation";
import { recordPayment } from "../../src/payment/recordPayment";
import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { fullyCancelledScene } from "../helpers/cancellationFixtures";

describe("전량 취소(CANCELLING) 주문의 신규 거래 차단 (ST-O06, BR-O07)", () => {
  it("전량 취소된 주문에는 결제 입력·재고 예약·조달 배정·취소 요청을 추가할 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const { deps, orderD, w, applyFullCancellation, cancelOrderRequest } = fullyCancelledScene();
    applyFullCancellation();
    const order = deps.orders.get("tenant-a", orderD.id)!;
    const lineId = orderD.lines[0]!.lineId;
    const codeOf = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(
      codeOf(() =>
        recordPayment(deps, {
          tenantId: "tenant-a",
          orderId: orderD.id,
          method: "CARD",
          amountKrw: "1000",
          externalReference: "AFTER-CANCEL",
          paidAt: "2026-03-04T06:00:00.000Z",
          recordedBy: "김직원",
          idempotencyKey: "pay-after-cancel",
        }),
      ),
    ).toBe("BUSINESS_INVARIANT");
    expect(
      codeOf(() =>
        reserveStock(deps, {
          tenantId: "tenant-a",
          orderId: orderD.id,
          orderLineId: lineId,
          quantity: 1,
          reservedBy: "김직원",
          reservedAt: "2026-03-04T06:40:00.000Z",
          idempotencyKey: "res-after-cancel",
        }),
      ),
    ).toBe("BUSINESS_INVARIANT");
    expect(
      codeOf(() =>
        allocateSourcing(w.deps, {
          tenantId: "tenant-a",
          orderId: orderD.id,
          lineId,
          supplierCode: "sup-a",
          quantity: 1,
          idempotencyKey: "alloc-after-cancel",
        }),
      ),
    ).toBe("BUSINESS_INVARIANT");
    expect(
      codeOf(() =>
        requestOrderCancellation(
          deps,
          cancelOrderRequest({ quantity: 1, expectedVersion: order.version }),
        ),
      ),
    ).toBe("BUSINESS_INVARIANT");
  });
});
