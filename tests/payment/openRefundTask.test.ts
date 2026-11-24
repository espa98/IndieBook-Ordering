import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { confirmPayment } from "../../src/payment/confirmPayment";
import { confirmRefund } from "../../src/payment/confirmRefund";
import { recordPayment } from "../../src/payment/recordPayment";
import { openRefundTask } from "../../src/payment/openRefundTask";
import { correctPayment } from "../../src/payment/correctPayment";
import { confirmationScene, overpaidScene, refundScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("openRefundTask: 과수납 환급 필요 업무 개설 (ST-Y05, DEC-14, BR-Y07/Y08)", () => {
  it("확인된 결제가 주문 총액을 넘으면 과수납분을 환급 필요액으로 하는 업무가 열린다(물량 처리와 독립)", () => {
    const { deps, openRequest, order, refundTasks } = overpaidScene(); // 총액 30,000, 확인 35,000

    const task = openRefundTask(deps, openRequest());

    expect(task).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: order.id,
      requiredKrw: "5000",
      openedBy: "김직원",
      openedAt: "2026-03-04T06:45:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(refundTasks.list("tenant-a", order.id)).toEqual([task]);
  });

  it("과수납이 없으면(환급 필요액 0) 업무를 열 수 없고, 이미 열린 업무가 있으면 중복 개설할 수 없다", () => {
    const exact = confirmationScene(); // 총액 30,000원, 확인 결제 없음
    let thrown: unknown;
    try {
      openRefundTask(
        {
          ...exact.deps,
          refundTasks: { get: () => undefined, list: () => [], save() {} },
          refundConfirmations: { list: () => [], listByOrder: () => [] },
          paymentCorrections: { listByOrder: () => [] },
        },
        { tenantId: "tenant-a", orderId: exact.order.id, openedBy: "김직원", openedAt: "2026-03-04T06:45:00.000Z", idempotencyKey: "x" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");

    const { deps, openRequest, order, refundTasks } = overpaidScene();
    openRefundTask(deps, openRequest());
    let duplicate: unknown;
    try {
      openRefundTask(deps, openRequest());
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(AppError);
    expect((duplicate as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(refundTasks.list("tenant-a", order.id)).toHaveLength(1);
  });

  it("담당자가 비었거나 openedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, openRequest, order, refundTasks } = overpaidScene();

    for (const bad of [
      openRequest({ openedBy: " " }),
      openRequest({ openedAt: "2026-03-04" }),
      openRequest({ openedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        openRefundTask(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(refundTasks.list("tenant-a", order.id)).toEqual([]);
  });

  it("없는 주문이거나 다른 테넌트의 주문이면 NOT_FOUND 404이다", () => {
    const { deps, openRequest } = overpaidScene();

    for (const bad of [openRequest({ orderId: "no-such-order" }), openRequest({ tenantId: "tenant-b" })]) {
      let thrown: unknown;
      try {
        openRefundTask(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
  });

  it("같은 멱등 키로 재호출하면 같은 업무를 돌려주고(중복 개설 오류가 아니다) 다시 만들지 않는다", () => {
    const { deps, openRequest, order, refundTasks } = overpaidScene();

    const first = openRefundTask(deps, openRequest({ idempotencyKey: "k" }));
    const replay = openRefundTask(deps, openRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(refundTasks.list("tenant-a", order.id)).toEqual([first]);
  });

  it("환급이 모두 확인된 업무는 종료되어 새 과수납이 생기면 새 업무를 열 수 있고, 필요액은 기환급분을 뺀 값이다", () => {
    const { deps, openRequest, refundRequest, order, paymentRequest, confirmRequest, refundTasks } = refundScene();
    confirmRefund(deps, refundRequest({ amountKrw: "5000" })); // 업무 1 완료 (과수납 0)

    expect(() => openRefundTask(deps, openRequest())).toThrow(AppError); // 과수납이 없다

    const extra = recordPayment(deps, paymentRequest({ method: "EASY_PAY", amountKrw: "4000", externalReference: "EASY-OP2" }));
    confirmPayment(deps, confirmRequest({ paymentId: extra.id })); // 새 과수납 4,000
    const second = openRefundTask(deps, openRequest());

    expect(second.requiredKrw).toBe("4000");
    expect(refundTasks.list("tenant-a", order.id)).toHaveLength(2);
  });

  it("결제 오기록 보정으로 확인 금액이 줄면 환급 필요액도 줄어(0이면 업무를 열 수 없다) 보정을 반영해 계산한다", () => {
    const { deps, openRequest, first, order, refundTasks } = overpaidScene(); // 확인 35,000, 총액 30,000
    correctPayment(deps, {
      tenantId: "tenant-a",
      paymentId: first.id,
      reducedKrw: "2000",
      reason: "입금액 오입력",
      evidence: "입금 내역 재확인",
      actorRole: "OWNER",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:55:00.000Z",
      idempotencyKey: "pcr-open",
    }); // 확인 33,000 → 과수납 3,000

    const task = openRefundTask(deps, openRequest());

    expect(task.requiredKrw).toBe("3000");
    expect(refundTasks.list("tenant-a", order.id)).toEqual([task]);
  });
});
