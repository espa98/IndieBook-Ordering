import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { requestRefund } from "../../src/payment/requestRefund";
import { reportRefundAttempt } from "../../src/payment/reportRefundAttempt";
import { refundAttemptScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("reportRefundAttempt: 환급 시도 실패·불명확 결과 보고 (ST-Y07, BR-Y07)", () => {
  it("환급 시도의 불명확(UNKNOWN) 결과를 사유와 함께 기록하고 환급 원장과 환급 확인은 기록하지 않는다", () => {
    const { deps, reportAttemptRequest, task, second, refundAttempts } = refundAttemptScene();

    const attempt = reportRefundAttempt(deps, reportAttemptRequest());

    expect(attempt).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      refundTaskId: task.id,
      orderId: task.orderId,
      paymentId: second.id,
      amountKrw: "3000",
      result: "UNKNOWN",
      reason: "카드사 응답 시간 초과, 취소 여부 불명",
      reportedBy: "김직원",
      reportedAt: "2026-03-04T06:49:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(refundAttempts.list("tenant-a", task.id)).toEqual([attempt]);
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([]);
  });

  it("금액·결과값·사유·보고자·시각이 잘못이면 VALIDATION_ERROR 400이고, 없는 업무·결제는 NOT_FOUND이며 아무것도 기록되지 않는다", () => {
    const { deps, reportAttemptRequest, refundAttempts, task } = refundAttemptScene();
    const codeOf = (extra: Parameters<typeof reportAttemptRequest>[0]) => {
      try {
        reportRefundAttempt(deps, reportAttemptRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    for (const bad of [
      { amountKrw: "0" },
      { amountKrw: "1.5" },
      { result: "CONFIRMED" as never },
      { reason: "" },
      { reportedBy: " " },
      { reportedAt: "2999-01-01T00:00:00.000Z" },
    ]) {
      expect(codeOf(bad)).toBe("VALIDATION_ERROR");
    }
    expect(codeOf({ paymentId: "no-such-payment" })).toBe("NOT_FOUND");
    expect(codeOf({ refundTaskId: "no-such-task" })).toBe("NOT_FOUND");
    expect(refundAttempts.list("tenant-a", task.id)).toEqual([]);
  });

  it("UNKNOWN 시도의 금액은 환급 한도에서 예약되어 재환급 요청이 막히고(TC-90), FAILED 시도는 예약하지 않는다", () => {
    const { deps, reportAttemptRequest, requestRefundRequest } = refundAttemptScene();
    const requestCode = (amountKrw: string) => {
      try {
        requestRefund(deps, requestRefundRequest({ amountKrw }));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    reportRefundAttempt(deps, reportAttemptRequest({ result: "FAILED", amountKrw: "4000" }));
    reportRefundAttempt(deps, reportAttemptRequest({ result: "UNKNOWN", amountKrw: "3000" }));

    expect(requestCode("3000")).toBe("BUSINESS_INVARIANT"); // 업무 5,000 - 예약 3,000 = 2,000
    expect(requestCode("2000")).toBeUndefined();
  });
});
