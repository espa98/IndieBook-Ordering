import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { reportRefundAttempt } from "../../src/payment/reportRefundAttempt";
import { requestRefund } from "../../src/payment/requestRefund";
import { resolveRefundAttempt } from "../../src/payment/resolveRefundAttempt";
import { unknownAttemptScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolveRefundAttempt: UNKNOWN 환급 시도 해소 (ST-Y07, BR-Y07, BR-Y12)", () => {
  it("조회 증빙과 함께 FAILED로 해소하면 해소 기록이 남고 예약이 풀려 같은 금액을 다시 요청할 수 있다", () => {
    const { deps, attempt, resolveAttemptRequest, requestRefundRequest, task, refundAttemptResolutions } =
      unknownAttemptScene();

    const resolution = resolveRefundAttempt(deps, resolveAttemptRequest());

    expect(resolution).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      attemptId: attempt.id,
      refundTaskId: task.id,
      outcome: "FAILED",
      evidence: "카드사 조회 결과 취소 내역 없음 2026-03-05",
      resolvedBy: "김직원",
      resolvedAt: "2026-03-04T06:50:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(refundAttemptResolutions.list("tenant-a", attempt.id)).toEqual([resolution]);
    expect(() => requestRefund(deps, requestRefundRequest({ amountKrw: "5000" }))).not.toThrow();
  });

  it("CONFIRMED로 해소해도 환급 원장은 기록되지 않는다 (원장은 요청·Owner 승인 경로에서만)", () => {
    const { deps, resolveAttemptRequest, task } = unknownAttemptScene();

    resolveRefundAttempt(deps, resolveAttemptRequest({ outcome: "CONFIRMED" }));

    expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([]);
  });

  it("이미 해소된 시도·FAILED로 보고된 시도는 해소할 수 없고(BUSINESS_INVARIANT 422), 증빙이 비었거나 결과값이 잘못이면 VALIDATION_ERROR 400이며, 없는 시도는 NOT_FOUND이다", () => {
    const { deps, attempt, resolveAttemptRequest, reportAttemptRequest, refundAttemptResolutions } =
      unknownAttemptScene();
    const failedAttempt = reportRefundAttempt(deps, reportAttemptRequest({ result: "FAILED", amountKrw: "1000" }));
    const codeOf = (extra: Parameters<typeof resolveAttemptRequest>[0]) => {
      try {
        resolveRefundAttempt(deps, resolveAttemptRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ evidence: "" })).toBe("VALIDATION_ERROR");
    expect(codeOf({ outcome: "UNKNOWN" as never })).toBe("VALIDATION_ERROR");
    expect(codeOf({ attemptId: "no-such-attempt" })).toBe("NOT_FOUND");
    expect(codeOf({ attemptId: failedAttempt.id })).toBe("BUSINESS_INVARIANT");
    expect(codeOf({})).toBeUndefined();
    expect(codeOf({ outcome: "CONFIRMED" })).toBe("BUSINESS_INVARIANT"); // 이미 해소됨
    expect(refundAttemptResolutions.list("tenant-a", attempt.id)).toHaveLength(1);
  });
});
