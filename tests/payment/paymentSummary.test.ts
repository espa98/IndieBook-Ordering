import { describe, it, expect } from "vitest";
import { confirmPayment } from "../../src/payment/confirmPayment";
import { paymentSummary } from "../../src/payment/paymentSummary";
import { recordPayment } from "../../src/payment/recordPayment";
import { voidPayment } from "../../src/payment/voidPayment";
import { confirmationScene } from "../helpers/paymentFixtures";

describe("paymentSummary: 주문별 결제 사실 요약 (DEC-14, BR-Y08, ST-Y05)", () => {
  it("확인된 거래만 확정 금액이고 미확인은 대기, 무효는 제외하며 여러 거래를 합산해 잔액을 구한다(총액 30,000원)", () => {
    const s = confirmationScene(); // 계좌이체 10,000원 입력(확인 전)
    const { deps, order, payment, paymentRequest, confirmRequest } = s;
    const summaryOf = () => {
      const payments = deps.payments.list("tenant-a", order.id);
      return paymentSummary(
        order,
        payments,
        payments.flatMap((p) => deps.paymentConfirmations.list("tenant-a", p.id)),
        payments.flatMap((p) => deps.paymentVoids.list("tenant-a", p.id)),
      );
    };

    expect(summaryOf()).toEqual({
      totalKrw: "30000",
      confirmedKrw: "0",
      pendingKrw: "10000",
      balanceKrw: "30000",
      refundRequiredKrw: "0",
    });

    confirmPayment(deps, confirmRequest({ paymentId: payment.id }));
    const second = recordPayment(deps, paymentRequest({ method: "CARD", amountKrw: "15000", externalReference: "CARD-1" }));
    const wrong = recordPayment(deps, paymentRequest({ method: "EASY_PAY", amountKrw: "99999", externalReference: "EASY-X" }));
    voidPayment(deps, {
      tenantId: "tenant-a",
      paymentId: wrong.id,
      reason: "오입력",
      voidedBy: "김직원",
      voidedAt: "2026-03-04T06:40:00.000Z",
      idempotencyKey: "void-wrong",
    });
    confirmPayment(deps, confirmRequest({ paymentId: second.id }));

    expect(summaryOf()).toEqual({
      totalKrw: "30000",
      confirmedKrw: "25000",
      pendingKrw: "0",
      balanceKrw: "5000",
      refundRequiredKrw: "0",
    });
  });

  it("확인된 금액이 주문 총액을 넘으면 과수납분은 환급 필요액으로 따로 계산하고 잔액은 0이다", () => {
    const s = confirmationScene();
    const { deps, order, payment, paymentRequest, confirmRequest } = s;
    const second = recordPayment(deps, paymentRequest({ method: "CARD", amountKrw: "25000", externalReference: "CARD-2" }));
    confirmPayment(deps, confirmRequest({ paymentId: payment.id }));
    confirmPayment(deps, confirmRequest({ paymentId: second.id }));
    const payments = deps.payments.list("tenant-a", order.id);

    const summary = paymentSummary(
      order,
      payments,
      payments.flatMap((p) => deps.paymentConfirmations.list("tenant-a", p.id)),
      [],
    );

    expect(summary).toEqual({
      totalKrw: "30000",
      confirmedKrw: "35000",
      pendingKrw: "0",
      balanceKrw: "0",
      refundRequiredKrw: "5000",
    });
  });
});
