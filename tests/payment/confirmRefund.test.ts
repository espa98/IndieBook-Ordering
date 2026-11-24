import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { correctPayment } from "../../src/payment/correctPayment";
import { recordPayment } from "../../src/payment/recordPayment";
import { confirmRefund } from "../../src/payment/confirmRefund";
import { heavilyOverpaidScene, refundScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("confirmRefund: 외부 환급 완료 사실 기록 (ST-Y06, DEC-06/09, BR-Y07/Y08)", () => {
  it("Owner가 외부에서 실제 환급이 끝난 사실을 원 결제·증빙과 함께 기록하며, 환급 실행이 아니라 수기 증빙 확인으로만 기록한다", () => {
    const { deps, refundRequest, task, second, refundConfirmations } = refundScene(); // 필요 5,000원

    const refund = confirmRefund(deps, refundRequest({ amountKrw: "3000" }));

    expect(refund).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      refundTaskId: task.id,
      orderId: task.orderId,
      paymentId: second.id,
      amountKrw: "3000",
      evidence: "카드사 부분 취소 승인 내역 2026-03-05",
      confirmedBy: "점주",
      confirmedAt: "2026-03-04T06:50:00.000Z",
      verificationSource: "STAFF_MANUAL_EVIDENCE",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(refund).not.toHaveProperty("providerVerified");
    expect(refundConfirmations.list("tenant-a", task.id)).toEqual([refund]);
  });

  it("환급은 업무의 남은 필요액(부분 환급 누적) 이내여야 하고, 확인되지 않은 결제나 다른 주문의 결제는 대상이 될 수 없다", () => {
    const { deps, refundRequest, second, refundConfirmations, paymentRequest, w } = refundScene();
    const attempt = (extra: Parameters<typeof refundRequest>[0]) => {
      try {
        confirmRefund(deps, refundRequest(extra));
      } catch (error) {
        return error as AppError;
      }
    };

    expect(attempt({ amountKrw: "5001" })?.code).toBe("BUSINESS_INVARIANT"); // 업무 필요액 5,000 초과
    expect(attempt({ amountKrw: "3000" })).toBeUndefined(); // 남은 2,000
    expect(attempt({ amountKrw: "2001" })?.code).toBe("BUSINESS_INVARIANT");
    expect(attempt({ amountKrw: "2000" })).toBeUndefined(); // 업무 완료(5,000)
    expect(attempt({ amountKrw: "1" })?.code).toBe("BUSINESS_INVARIANT"); // 남은 필요액 0

    expect(refundConfirmations.listByPayment("tenant-a", second.id)).toHaveLength(2);

    // 확인되지 않은 결제·다른 주문의 결제는 대상이 될 수 없다
    const other = w.addOrder([{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }]);
    const foreign = recordPayment(deps, paymentRequest({ orderId: other.id, externalReference: "OTHER-1" }));
    expect(attempt({ paymentId: foreign.id, amountKrw: "1" })?.code).toBe("BUSINESS_INVARIANT");
    expect(attempt({ paymentId: "no-such-payment", amountKrw: "1" })?.code).toBe("NOT_FOUND");
  });

  it("원 결제별 상한: 한 결제에 대한 환급 합계는 그 결제액을 넘을 수 없다(업무 필요액이 남아 있어도 다른 결제로 환급해야 한다)", () => {
    const { deps, refundRequest, payments: [p1, p2], task, refundConfirmations } = heavilyOverpaidScene(); // 20,000원 결제 3건, 필요 30,000원
    const attempt = (extra: Parameters<typeof refundRequest>[0]) => {
      try {
        confirmRefund(deps, refundRequest(extra));
      } catch (error) {
        return error as AppError;
      }
    };

    expect(attempt({ paymentId: p1!.id, amountKrw: "20000" })).toBeUndefined(); // 결제 1 상한 소진
    const overCap = attempt({ paymentId: p1!.id, amountKrw: "1" }); // 업무 필요액은 10,000원 남음
    expect(overCap?.code).toBe("BUSINESS_INVARIANT");
    expect(attempt({ paymentId: p2!.id, amountKrw: "10000" })).toBeUndefined(); // 다른 결제로 환급
    expect(refundConfirmations.list("tenant-a", task.id)).toHaveLength(2);
  });

  it("STAFF는 환급 완료를 확인할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다 (DEC-09)", () => {
    const { deps, refundRequest, task, refundConfirmations } = refundScene();

    let thrown: unknown;
    try {
      confirmRefund(deps, refundRequest({ actorRole: "STAFF" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).httpStatus).toBe(403);
    expect(refundConfirmations.list("tenant-a", task.id)).toEqual([]);
  });

  it("금액이 양의 정수 문자열이 아니거나 증빙·확인자가 비었거나 confirmedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, refundRequest, task, refundConfirmations } = refundScene();

    for (const bad of [
      refundRequest({ amountKrw: "0" }),
      refundRequest({ amountKrw: "-1" }),
      refundRequest({ amountKrw: "10.5" }),
      refundRequest({ amountKrw: "" }),
      refundRequest({ amountKrw: 3000 as never }),
      refundRequest({ evidence: " " }),
      refundRequest({ confirmedBy: "" }),
      refundRequest({ confirmedAt: "2026-03-04" }),
      refundRequest({ confirmedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        confirmRefund(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(refundConfirmations.list("tenant-a", task.id)).toEqual([]);
  });

  it("없는 환급 업무이거나 다른 테넌트의 업무면 NOT_FOUND 404이다", () => {
    const { deps, refundRequest, task, refundConfirmations } = refundScene();

    for (const bad of [
      refundRequest({ refundTaskId: "no-such-task" }),
      refundRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        confirmRefund(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(refundConfirmations.list("tenant-a", task.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 환급 확인을 돌려주고 환급액을 중복 반영하지 않는다", () => {
    const { deps, refundRequest, task, refundConfirmations } = refundScene();

    const first = confirmRefund(deps, refundRequest({ amountKrw: "5000", idempotencyKey: "k" }));
    const replay = confirmRefund(deps, refundRequest({ amountKrw: "5000", idempotencyKey: "k" })); // 업무는 이미 소진

    expect(replay).toEqual(first);
    expect(refundConfirmations.list("tenant-a", task.id)).toEqual([first]);
  });

  it("원 결제가 오기록 보정으로 줄었으면 환급 상한도 보정 후 금액(거래액-보정-기환급)이다", () => {
    const { deps, refundRequest, payments: [p1] } = heavilyOverpaidScene(); // 20,000원 결제 3건, 필요 30,000원
    correctPayment(deps, {
      tenantId: "tenant-a",
      paymentId: p1!.id,
      reducedKrw: "5000",
      reason: "입금액 오입력",
      evidence: "입금 내역 재확인",
      actorRole: "OWNER",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:55:00.000Z",
      idempotencyKey: "pcr-refund",
    }); // 결제 1 유효액 15,000원
    const attempt = (amountKrw: string) => {
      try {
        confirmRefund(deps, refundRequest({ paymentId: p1!.id, amountKrw, idempotencyKey: `r-${amountKrw}` }));
      } catch (error) {
        return error as AppError;
      }
    };

    expect(attempt("15001")?.code).toBe("BUSINESS_INVARIANT");
    expect(attempt("15000")).toBeUndefined();
  });
});
