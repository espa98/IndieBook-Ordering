import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { recordPayment } from "../../src/payment/recordPayment";
import { requestRefund } from "../../src/payment/requestRefund";
import { refundRequestScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("requestRefund: Staff의 환급 완료 확인 요청 (ST-Y06, DEC-09, BR-Y07/Y08)", () => {
  it("Staff가 외부 환급 완료 증빙과 함께 요청하면 요청 기록만 남고 환급 원장은 기록되지 않는다 (Owner 승인 전)", () => {
    const { deps, requestRefundRequest, task, second, refundRequests } = refundRequestScene();

    const request = requestRefund(deps, requestRefundRequest({ amountKrw: "3000" }));

    expect(request).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      refundTaskId: task.id,
      orderId: task.orderId,
      paymentId: second.id,
      amountKrw: "3000",
      evidence: "카드사 부분 취소 승인 내역 2026-03-05",
      requestedBy: "김직원",
      requestedAt: "2026-03-04T06:48:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(refundRequests.list("tenant-a", task.id)).toEqual([request]);
    expect(deps.refundConfirmations.list("tenant-a", task.id)).toEqual([]);
  });

  it("두 세션이 같은 환급 필요액을 동시에 요청해도 진행 중인 요청을 포함한 합계가 업무 남은 필요액(5,000원)을 넘을 수 없다 (중복 환급 방지)", () => {
    const { deps, requestRefundRequest, task, refundRequests } = refundRequestScene();
    const request = (amountKrw: string, requestedBy: string) => {
      try {
        requestRefund(deps, requestRefundRequest({ amountKrw, requestedBy }));
      } catch (error) {
        return error as AppError;
      }
    };

    expect(request("3000", "세션A")).toBeUndefined(); // 요청 합계 3,000
    expect(request("3000", "세션B")?.code).toBe("BUSINESS_INVARIANT"); // 같은 3,000 → 6,000 > 5,000
    expect(request("2000", "세션B")).toBeUndefined(); // 합계 5,000
    expect(request("1", "세션C")?.code).toBe("BUSINESS_INVARIANT");
    expect(refundRequests.list("tenant-a", task.id).map((r) => r.amountKrw)).toEqual(["3000", "2000"]);
  });

  it("확인되지 않은 결제·다른 주문의 결제는 대상이 될 수 없고, 없는 결제·업무는 NOT_FOUND이다", () => {
    const { deps, requestRefundRequest, paymentRequest, w } = refundRequestScene();
    const other = w.addOrder([{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }]);
    const foreign = recordPayment(deps, paymentRequest({ orderId: other.id, externalReference: "RR-OTHER" }));
    const codeOf = (extra: Parameters<typeof requestRefundRequest>[0]) => {
      try {
        requestRefund(deps, requestRefundRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ paymentId: foreign.id, amountKrw: "1" })).toBe("BUSINESS_INVARIANT");
    expect(codeOf({ paymentId: "no-such-payment" })).toBe("NOT_FOUND");
    expect(codeOf({ refundTaskId: "no-such-task" })).toBe("NOT_FOUND");
    expect(codeOf({ tenantId: "tenant-b" })).toBe("NOT_FOUND");
  });

  it("금액이 양의 정수 문자열이 아니거나 증빙·요청자가 비었거나 requestedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, requestRefundRequest, task, refundRequests } = refundRequestScene();

    for (const bad of [
      requestRefundRequest({ amountKrw: "0" }),
      requestRefundRequest({ amountKrw: "-1" }),
      requestRefundRequest({ amountKrw: "1.5" }),
      requestRefundRequest({ amountKrw: 3000 as never }),
      requestRefundRequest({ evidence: " " }),
      requestRefundRequest({ requestedBy: "" }),
      requestRefundRequest({ requestedAt: "2026-03-04" }),
      requestRefundRequest({ requestedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        requestRefund(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(refundRequests.list("tenant-a", task.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 요청을 돌려주고(한도 오류가 아니다) 중복 예약하지 않는다", () => {
    const { deps, requestRefundRequest, task, refundRequests } = refundRequestScene();

    const first = requestRefund(deps, requestRefundRequest({ amountKrw: "5000", idempotencyKey: "k" }));
    const replay = requestRefund(deps, requestRefundRequest({ amountKrw: "5000", idempotencyKey: "k" })); // 한도 소진 후

    expect(replay).toEqual(first);
    expect(refundRequests.list("tenant-a", task.id)).toEqual([first]);
  });
});
