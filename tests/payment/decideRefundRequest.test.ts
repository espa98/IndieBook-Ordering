import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { correctPayment } from "../../src/payment/correctPayment";
import { requestRefund } from "../../src/payment/requestRefund";
import { decideRefundRequest } from "../../src/payment/decideRefundRequest";
import { refundDecisionScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("decideRefundRequest: Owner의 환급 요청 승인·거절·철회 (ST-Y06, DEC-09, BR-Y07/Y08)", () => {
  it("Owner가 승인하면 요청의 증빙을 근거로 환급 원장이 기록되고 승인 결정이 함께 남는다 (승인 AND 외부 환급 증빙)", () => {
    const { deps, decideRefundRequest: decideRequest, refundRequestRecord, task, second } = refundDecisionScene();

    const result = decideRefundRequest(deps, decideRequest({ decision: "APPROVED" }));

    expect(result.decision).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      requestId: refundRequestRecord.id,
      kind: "APPROVED",
      decidedBy: "점주",
      decidedAt: "2026-03-04T06:52:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(result.refund).toMatchObject({
      refundTaskId: task.id,
      paymentId: second.id,
      amountKrw: "3000",
      evidence: refundRequestRecord.evidence,
      confirmedBy: "점주",
      refundRequestId: refundRequestRecord.id,
      verificationSource: "STAFF_MANUAL_EVIDENCE",
    });
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([result.refund]);
    expect(deps.refundRequestDecisions.list("tenant-a", refundRequestRecord.id)).toEqual([result.decision]);
  });

  it("거절·철회는 환급 원장을 만들지 않고 요청을 종결해 예약된 금액을 풀며, 승인·거절은 Owner 전용·철회는 Staff도 가능하다", () => {
    for (const [decision, actorRole, decidedBy] of [
      ["REJECTED", "OWNER", "점주"],
      ["WITHDRAWN", "STAFF", "김직원"],
    ] as const) {
      const { deps, decideRefundRequest: decideRequest, requestRefundRequest, refundRequestRecord, task } =
        refundDecisionScene();

      const result = decideRefundRequest(deps, decideRequest({ decision, actorRole, decidedBy }));

      expect(result.decision.kind).toBe(decision);
      expect(result.refund).toBeUndefined();
      expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([]);
      // 예약이 풀려 같은 금액을 다시 요청할 수 있다
      expect(() => requestRefund(deps, requestRefundRequest({ amountKrw: "5000" }))).not.toThrow();
      void refundRequestRecord;
    }

    const { deps, decideRefundRequest: decideRequest, refundRequestRecord, task } = refundDecisionScene();
    for (const decision of ["APPROVED", "REJECTED"] as const) {
      let thrown: unknown;
      try {
        decideRefundRequest(deps, decideRequest({ decision, actorRole: "STAFF" }));
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AppError).code).toBe("FORBIDDEN");
    }
    expect(deps.refundRequestDecisions.list("tenant-a", refundRequestRecord.id)).toEqual([]);
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([]);
  });

  it("이미 결정된 요청은 다시 결정할 수 없다(두 번 승인해도 환급 원장은 한 번만, BUSINESS_INVARIANT 422)", () => {
    const { deps, decideRefundRequest: decideRequest, refundRequestRecord, task } = refundDecisionScene();
    decideRefundRequest(deps, decideRequest({ decision: "APPROVED" }));

    for (const decision of ["APPROVED", "REJECTED", "WITHDRAWN"] as const) {
      let thrown: unknown;
      try {
        decideRefundRequest(deps, decideRequest({ decision })); // 새 멱등 키
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    }
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toHaveLength(1);
    expect(deps.refundRequestDecisions.list("tenant-a", refundRequestRecord.id)).toHaveLength(1);
  });

  it("요청 뒤 승인 전에 대상 결제가 보정되어 한도를 넘게 되면 승인이 거부되고 결정도 환급 원장도 남지 않는다 (승인 후 대상 변경 재검증)", () => {
    const { deps, decideRefundRequest: decideRequest, refundRequestRecord, task, second } = refundDecisionScene(); // 25,000원 결제에 3,000원 요청
    correctPayment(deps, {
      tenantId: "tenant-a",
      paymentId: second.id,
      reducedKrw: "23000",
      reason: "입금액 오입력",
      evidence: "입금 내역 재확인",
      actorRole: "OWNER",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:50:00.000Z",
      idempotencyKey: "pcr-ra3",
    }); // 결제 유효액 2,000원 < 요청 3,000원

    let thrown: unknown;
    try {
      decideRefundRequest(deps, decideRequest({ decision: "APPROVED" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([]);
    expect(deps.refundRequestDecisions.list("tenant-a", refundRequestRecord.id)).toEqual([]);
  });

  it("결정 종류가 잘못이거나 결정자가 비었거나 decidedAt이 잘못·미래이면 VALIDATION_ERROR 400, 없는 요청·타 테넌트는 NOT_FOUND 404이고 아무것도 기록되지 않는다", () => {
    const { deps, decideRefundRequest: decideRequest, refundRequestRecord, task } = refundDecisionScene();
    const codeOf = (request: ReturnType<typeof decideRequest>) => {
      try {
        decideRefundRequest(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(decideRequest({ decision: "APPLIED" as never }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ decidedBy: " " }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ decidedAt: "2026-03-04" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ decidedAt: "2026-03-04T08:00:00.000Z" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ requestId: "no-such-request" }))).toBe("NOT_FOUND");
    expect(codeOf(decideRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([]);
    expect(deps.refundRequestDecisions.list("tenant-a", refundRequestRecord.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 승인 결과를 돌려주고 환급 원장을 중복 기록하지 않는다", () => {
    const { deps, decideRefundRequest: decideRequest, task } = refundDecisionScene();

    const first = decideRefundRequest(deps, decideRequest({ idempotencyKey: "k" }));
    const replay = decideRefundRequest(deps, decideRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toHaveLength(1);
  });
});
