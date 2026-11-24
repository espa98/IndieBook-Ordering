import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { confirmPayment } from "../../src/payment/confirmPayment";
import { voidPayment } from "../../src/payment/voidPayment";
import { voidScene } from "../helpers/paymentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("voidPayment: 미확인 거래 무효 (ST-Y03, UC-14)", () => {
  it("확인 전 거래를 사유와 함께 무효 처리하면 무효 기록이 남고 원 거래 기록은 삭제·수정되지 않는다", () => {
    const { deps, voidRequest, payment, payments } = voidScene();
    const paymentBefore = structuredClone(payments.get("tenant-a", payment.id));

    const result = voidPayment(deps, voidRequest());

    expect(result).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      paymentId: payment.id,
      reason: "실제 입금이 확인되지 않아 오입력으로 무효 처리",
      voidedBy: "김직원",
      voidedAt: "2026-03-04T06:40:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(deps.paymentVoids.list("tenant-a", payment.id)).toEqual([result]);
    expect(payments.get("tenant-a", payment.id)).toEqual(paymentBefore);
  });

  it("이미 확인된 거래는 무효 처리할 수 없고(정정은 별도 보정 거래), 이미 무효인 거래를 다시 무효 처리할 수 없다", () => {
    const confirmed = voidScene();
    confirmPayment(confirmed.deps, confirmed.confirmRequest());
    const voided = voidScene();
    voidPayment(voided.deps, voided.voidRequest());
    const attempt = (scene: ReturnType<typeof voidScene>) => {
      try {
        voidPayment(scene.deps, scene.voidRequest());
      } catch (error) {
        return error;
      }
    };

    for (const scene of [confirmed, voided]) {
      const thrown = attempt(scene);
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    }
    expect(confirmed.deps.paymentVoids.list("tenant-a", confirmed.payment.id)).toEqual([]);
    expect(voided.deps.paymentVoids.list("tenant-a", voided.payment.id)).toHaveLength(1);
  });

  it("사유·담당자가 비었거나 voidedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, voidRequest, payment } = voidScene();

    for (const bad of [
      voidRequest({ reason: " " }),
      voidRequest({ voidedBy: "" }),
      voidRequest({ voidedAt: "2026-03-04" }),
      voidRequest({ voidedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        voidPayment(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.paymentVoids.list("tenant-a", payment.id)).toEqual([]);
  });

  it("없는 거래이거나 다른 테넌트의 거래면 NOT_FOUND 404이다", () => {
    const { deps, voidRequest, payment } = voidScene();

    for (const bad of [
      voidRequest({ paymentId: "no-such-payment" }),
      voidRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        voidPayment(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.paymentVoids.list("tenant-a", payment.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 무효 기록을 돌려주고(이미 무효 오류가 아니다) 중복 기록하지 않는다", () => {
    const { deps, voidRequest, payment } = voidScene();

    const first = voidPayment(deps, voidRequest({ idempotencyKey: "k" }));
    const replay = voidPayment(deps, voidRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.paymentVoids.list("tenant-a", payment.id)).toEqual([first]);
  });
});
