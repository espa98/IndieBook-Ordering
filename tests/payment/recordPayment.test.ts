import { describe, it, expect } from "vitest";
import { addOrderLine } from "../../src/order/addOrderLine";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { AppError } from "../../src/errors/AppError";
import { recordPayment } from "../../src/payment/recordPayment";
import { paymentScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("recordPayment: 외부 결제 거래 사실 입력 (ST-Y01, UC-14, DEC-06/14)", () => {
  it("외부에서 이미 일어난 거래를 입력하면 확인 전(검증 전) 기록이 남고, 실제 승인을 실행하거나 검증된 것으로 표시하지 않는다", () => {
    const { deps, paymentRequest, order, payments } = paymentScene();

    const payment = recordPayment(deps, paymentRequest({ method: "BANK_TRANSFER", amountKrw: "10000" }));

    expect(payment).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: order.id,
      method: "BANK_TRANSFER",
      amountKrw: "10000",
      externalReference: "BANK-1",
      paidAt: "2026-03-04T06:00:00.000Z",
      recordedBy: "김직원",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(payments.list("tenant-a", order.id)).toEqual([payment]);
    expect(payment).not.toHaveProperty("providerVerified");
    expect(payment).not.toHaveProperty("status"); // 상태는 확인·무효 기록에서 파생한다
  });

  it("수단이 허용 3종이 아니거나 금액이 양의 정수가 아니거나 참조번호·담당자가 비었거나 paidAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, paymentRequest, order, payments } = paymentScene(); // now = 2026-03-04T07:00Z

    for (const bad of [
      paymentRequest({ method: "CASH" as never }),
      paymentRequest({ amountKrw: "0" }),
      paymentRequest({ amountKrw: "-1000" }),
      paymentRequest({ amountKrw: "1000.5" }),
      paymentRequest({ amountKrw: "01000" }),
      paymentRequest({ amountKrw: "" }),
      paymentRequest({ amountKrw: 1000 as never }),
      paymentRequest({ externalReference: " " }),
      paymentRequest({ recordedBy: "" }),
      paymentRequest({ paidAt: "2026-03-04" }),
      paymentRequest({ paidAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        recordPayment(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(payments.list("tenant-a", order.id)).toEqual([]);
  });

  it("없는 주문·다른 테넌트의 주문은 NOT_FOUND 404, 확정 전 초안 주문은 BUSINESS_INVARIANT 422이다", () => {
    const { deps, paymentRequest, order, payments } = paymentScene();
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });
    deps.orders.save(draft);
    const codeOf = (request: ReturnType<typeof paymentRequest>) => {
      try {
        recordPayment(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(paymentRequest({ orderId: "no-such-order" }))).toBe("NOT_FOUND");
    expect(codeOf(paymentRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(codeOf(paymentRequest({ orderId: draft.id }))).toBe("BUSINESS_INVARIANT");
    expect(payments.list("tenant-a", order.id)).toEqual([]);
    expect(payments.list("tenant-a", draft.id)).toEqual([]);
  });

  it("같은 서점·수단·외부 참조번호의 거래는 다른 요청(다른 멱등 키·다른 주문)으로도 다시 기록할 수 없다 (중복 외부 거래)", () => {
    const { deps, paymentRequest, order, payments, w } = paymentScene();
    const other = w.addOrder([{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }]);
    recordPayment(deps, paymentRequest({ method: "BANK_TRANSFER", externalReference: "TX-1" }));

    for (const duplicate of [
      paymentRequest({ method: "BANK_TRANSFER", externalReference: "TX-1" }),
      paymentRequest({ method: "BANK_TRANSFER", externalReference: " TX-1 " }),
      paymentRequest({ orderId: other.id, method: "BANK_TRANSFER", externalReference: "TX-1" }),
    ]) {
      let thrown: unknown;
      try {
        recordPayment(deps, duplicate);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    }
    expect(payments.listByTenant("tenant-a")).toHaveLength(1);

    // 수단이 다르면 다른 거래다
    recordPayment(deps, paymentRequest({ method: "CARD", externalReference: "TX-1" }));
    expect(payments.list("tenant-a", order.id)).toHaveLength(2);
  });

  it("같은 멱등 키로 재호출하면 같은 기록을 돌려주고(중복 외부 거래 오류가 아니다) 다시 저장하지 않는다", () => {
    const { deps, paymentRequest, order, payments } = paymentScene();

    const first = recordPayment(deps, paymentRequest({ externalReference: "TX-9", idempotencyKey: "k" }));
    const replay = recordPayment(deps, paymentRequest({ externalReference: "TX-9", idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(payments.list("tenant-a", order.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, paymentRequest, order, payments } = paymentScene();
    recordPayment(deps, paymentRequest({ amountKrw: "10000", externalReference: "TX-9", idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      recordPayment(deps, paymentRequest({ amountKrw: "20000", externalReference: "TX-9", idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(payments.list("tenant-a", order.id)).toHaveLength(1);
  });
});
