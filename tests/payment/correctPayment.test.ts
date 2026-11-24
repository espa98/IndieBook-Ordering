import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { recordPayment } from "../../src/payment/recordPayment";
import { correctPayment } from "../../src/payment/correctPayment";
import { paymentSummary } from "../../src/payment/paymentSummary";
import { confirmRefund } from "../../src/payment/confirmRefund";
import {
  createInMemoryPaymentCorrectionRepository,
  paymentCorrectionScene,
  refundScene,
} from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("correctPayment: 확인된 결제의 오기록 정정 (ST-Y04, DEC-09, §11.7)", () => {
  it("Owner가 확인된 거래를 감액 보정하면 원거래는 그대로 두고 보정 기록이 남으며 결제 요약에 반영된다", () => {
    const { deps, correctPaymentRequest, first, order } = paymentCorrectionScene(); // 확인 10,000 + 25,000
    const paymentBefore = structuredClone(deps.payments.get("tenant-a", first.id));
    const summaryOf = () => {
      const payments = deps.payments.list("tenant-a", order.id);
      return paymentSummary(
        order,
        payments,
        payments.flatMap((p) => deps.paymentConfirmations.list("tenant-a", p.id)),
        payments.flatMap((p) => deps.paymentVoids.list("tenant-a", p.id)),
        deps.refundConfirmations.listByOrder("tenant-a", order.id),
        deps.paymentCorrections.listByOrder("tenant-a", order.id),
      );
    };
    expect(summaryOf()).toMatchObject({ confirmedKrw: "35000", refundRequiredKrw: "5000" });

    const correction = correctPayment(deps, correctPaymentRequest({ reducedKrw: "2000" }));

    expect(correction).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: order.id,
      paymentId: first.id,
      reducedKrw: "2000",
      reason: "입금액을 10,000원으로 잘못 입력 (실제 8,000원)",
      evidence: "은행 입금 내역 재확인 2026-03-05",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:55:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(deps.payments.get("tenant-a", first.id)).toEqual(paymentBefore); // 원금 직접 수정 금지
    expect(summaryOf()).toMatchObject({ confirmedKrw: "33000", refundRequiredKrw: "3000" });
  });

  it("정정은 확인된 거래에만 가능하고, 누적 보정은 거래액(10,000원)을 넘을 수 없다", () => {
    const { deps, correctPaymentRequest, first, paymentRequest, paymentCorrections } = paymentCorrectionScene();
    const attempt = (extra: Parameters<typeof correctPaymentRequest>[0]) => {
      try {
        correctPayment(deps, correctPaymentRequest(extra));
      } catch (error) {
        return error as AppError;
      }
    };

    expect(attempt({ reducedKrw: "10001" })?.code).toBe("BUSINESS_INVARIANT");
    expect(attempt({ reducedKrw: "6000" })).toBeUndefined();
    expect(attempt({ reducedKrw: "4001" })?.code).toBe("BUSINESS_INVARIANT"); // 남은 4,000
    expect(attempt({ reducedKrw: "4000" })).toBeUndefined();
    expect(attempt({ reducedKrw: "1" })?.code).toBe("BUSINESS_INVARIANT");
    expect(paymentCorrections.list("tenant-a", first.id)).toHaveLength(2);

    const pending = recordPayment(deps, paymentRequest({ externalReference: "PEND-1" })); // 확인 전
    expect(attempt({ paymentId: pending.id, reducedKrw: "1" })?.code).toBe("BUSINESS_INVARIANT");
    expect(attempt({ paymentId: "no-such-payment", reducedKrw: "1" })?.code).toBe("NOT_FOUND");
  });

  it("이미 환급이 확정된 금액은 보정으로 다시 줄일 수 없다 (거래액 - 기환급 - 기보정 이내)", () => {
    const s = refundScene(); // 25,000원 결제에 대해 환급을 확정한다
    const deps = { ...s.deps, paymentCorrections: createInMemoryPaymentCorrectionRepository() };
    confirmRefund(deps, s.refundRequest({ paymentId: s.second.id, amountKrw: "3000" })); // 가용 22,000
    const attempt = (reducedKrw: string) => {
      try {
        correctPayment(deps, {
          tenantId: "tenant-a",
          paymentId: s.second.id,
          reducedKrw,
          reason: "오기록 정정",
          evidence: "입금 내역 재확인",
          actorRole: "OWNER",
          correctedBy: "점주",
          correctedAt: "2026-03-04T06:55:00.000Z",
          idempotencyKey: `pcr-r-${reducedKrw}`,
        });
      } catch (error) {
        return error as AppError;
      }
    };

    expect(attempt("22001")?.code).toBe("BUSINESS_INVARIANT");
    expect(attempt("22000")).toBeUndefined();
  });

  it("STAFF는 결제를 정정할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다 (DEC-09 거래 정정)", () => {
    const { deps, correctPaymentRequest, first, paymentCorrections } = paymentCorrectionScene();

    let thrown: unknown;
    try {
      correctPayment(deps, correctPaymentRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(paymentCorrections.list("tenant-a", first.id)).toEqual([]);
  });

  it("보정액이 양의 정수 문자열이 아니거나 사유·증빙·담당자가 비었거나 correctedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, correctPaymentRequest, first, paymentCorrections } = paymentCorrectionScene();

    for (const bad of [
      correctPaymentRequest({ reducedKrw: "0" }),
      correctPaymentRequest({ reducedKrw: "-5" }),
      correctPaymentRequest({ reducedKrw: "10.5" }),
      correctPaymentRequest({ reducedKrw: 2000 as never }),
      correctPaymentRequest({ reason: " " }),
      correctPaymentRequest({ evidence: "" }),
      correctPaymentRequest({ correctedBy: "" }),
      correctPaymentRequest({ correctedAt: "2026-03-04" }),
      correctPaymentRequest({ correctedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        correctPayment(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(paymentCorrections.list("tenant-a", first.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 보정을 돌려주고 중복 반영하지 않는다", () => {
    const { deps, correctPaymentRequest, first, paymentCorrections } = paymentCorrectionScene();

    const once = correctPayment(deps, correctPaymentRequest({ reducedKrw: "6000", idempotencyKey: "k" }));
    const replay = correctPayment(deps, correctPaymentRequest({ reducedKrw: "6000", idempotencyKey: "k" }));

    expect(replay).toEqual(once);
    expect(paymentCorrections.list("tenant-a", first.id)).toEqual([once]);
  });
});
