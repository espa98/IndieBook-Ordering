import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { voidPayment } from "../../src/payment/voidPayment";
import { confirmPayment } from "../../src/payment/confirmPayment";
import { confirmationScene, voidScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("confirmPayment: 외부 증빙 확인 (ST-Y02, UC-14, DEC-06)", () => {
  it("증빙과 확인자를 남겨 확인하며, 증빙 확인은 결제 제공사의 검증이 아니라 직원의 수기 확인으로만 기록한다", () => {
    const { deps, confirmRequest, payment, payments } = confirmationScene();
    const paymentBefore = structuredClone(payments.get("tenant-a", payment.id));

    const confirmation = confirmPayment(deps, confirmRequest());

    expect(confirmation).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      paymentId: payment.id,
      evidence: "계좌 입금 내역 캡처 2026-03-04, 입금자명 일치",
      confirmedBy: "김직원",
      confirmedAt: "2026-03-04T06:30:00.000Z",
      verificationSource: "STAFF_MANUAL_EVIDENCE",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(confirmation).not.toHaveProperty("providerVerified");
    expect(deps.paymentConfirmations.list("tenant-a", payment.id)).toEqual([confirmation]);
    expect(payments.get("tenant-a", payment.id)).toEqual(paymentBefore);
  });

  it("이미 확인된 거래를 다시 확인할 수 없다(다른 멱등 키여도 BUSINESS_INVARIANT 422)", () => {
    const { deps, confirmRequest, payment } = confirmationScene();
    confirmPayment(deps, confirmRequest());

    let thrown: unknown;
    try {
      confirmPayment(deps, confirmRequest()); // 새 멱등 키
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).httpStatus).toBe(422);
    expect(deps.paymentConfirmations.list("tenant-a", payment.id)).toHaveLength(1);
  });

  it("증빙·확인자가 비었거나 confirmedAt이 잘못·미래이면 VALIDATION_ERROR 400이다 (증빙 없는 확인 금지)", () => {
    const { deps, confirmRequest, payment } = confirmationScene();

    for (const bad of [
      confirmRequest({ evidence: " " }),
      confirmRequest({ evidence: "" }),
      confirmRequest({ confirmedBy: "" }),
      confirmRequest({ confirmedAt: "2026-03-04" }),
      confirmRequest({ confirmedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        confirmPayment(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.paymentConfirmations.list("tenant-a", payment.id)).toEqual([]);
  });

  it("없는 거래이거나 다른 테넌트의 거래면 NOT_FOUND 404이다", () => {
    const { deps, confirmRequest, payment } = confirmationScene();

    for (const bad of [
      confirmRequest({ paymentId: "no-such-payment" }),
      confirmRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        confirmPayment(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.paymentConfirmations.list("tenant-a", payment.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 확인을 돌려주고(이미 확인됨 오류가 아니다) 중복 기록하지 않는다", () => {
    const { deps, confirmRequest, payment } = confirmationScene();

    const first = confirmPayment(deps, confirmRequest({ idempotencyKey: "k" }));
    const replay = confirmPayment(deps, confirmRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.paymentConfirmations.list("tenant-a", payment.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, confirmRequest, payment } = confirmationScene();
    confirmPayment(deps, confirmRequest({ evidence: "증빙 A", idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      confirmPayment(deps, confirmRequest({ evidence: "증빙 B", idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.paymentConfirmations.list("tenant-a", payment.id)).toHaveLength(1);
  });

  it("무효 처리된 거래는 확인할 수 없다", () => {
    const { deps, confirmRequest, voidRequest, payment } = voidScene();
    voidPayment(deps, voidRequest());

    let thrown: unknown;
    try {
      confirmPayment(deps, confirmRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(deps.paymentConfirmations.list("tenant-a", payment.id)).toEqual([]);
  });
});
