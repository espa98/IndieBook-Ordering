import { describe, it, expect } from "vitest";
import { confirmPurchaseOrderCancellation } from "../../src/procurement/confirmPurchaseOrderCancellation";
import { createCancellationRequest } from "../../src/procurement/createCancellationRequest";
import { respondToCancellationRequest } from "../../src/procurement/respondToCancellationRequest";
import { recordSupplierReply } from "../../src/procurement/recordSupplierReply";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { sentScene } from "../helpers/procurementWorld";

const REPLIED_AT = "2026-03-04T05:30:00.000Z";
const NOW = "2026-03-04T07:00:00.000Z"; // sentScene의 deps.now

function scene(options: Parameters<typeof sentScene>[0] = {}) {
  const s = sentScene(options);
  let n = 0;
  /** 품목에 취소를 요청하고 공급처가 quantity 중 accepted만큼 수락하게 한다 */
  const cancel = (poLineId: string, quantity: number, accepted = quantity) => {
    const asked = createCancellationRequest(s.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      poLineId,
      quantity,
      reason: "고객 취소",
      idempotencyKey: `ask-${++n}`,
    });
    respondToCancellationRequest(s.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      cancellationRequestId: asked.id,
      acceptedQuantity: accepted,
      rejectedQuantity: quantity - accepted,
      evidence: "공급처 수락 회신",
      repliedAt: REPLIED_AT,
      idempotencyKey: `answer-${++n}`,
    });
    return asked;
  };
  const outOfStock = (poLineId: string, quantity: number) =>
    recordSupplierReply(s.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      poLineId,
      kind: "OUT_OF_STOCK",
      quantity,
      evidence: "공급처 이메일 (품절 확정)",
      repliedAt: REPLIED_AT,
      idempotencyKey: `oos-${++n}`,
    });
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: s.sent.id,
    expectedVersion: s.deps.purchaseOrders.get("tenant-a", s.sent.id)!.version,
    idempotencyKey: "cancel-po-1",
    ...extra,
  });
  return { ...s, cancel, outOfStock, request };
}

describe("confirmPurchaseOrderCancellation (ST-P10: 공급처 전량 취소 확정, SENT/ACKNOWLEDGED → CANCELLED)", () => {
  it("모든 품목의 유효 발주량이 0이고 수락 근거가 있으면 CANCELLED가 되고, 품목·전달·회신 기록은 그대로 보존된다", () => {
    const { sent, deps, poLineId, cancel, request } = scene(); // 발주 6권
    cancel(poLineId, 6); // 공급처가 6권 전부 취소 수락
    const poBefore = structuredClone(deps.purchaseOrders.get("tenant-a", sent.id)!);

    const cancelled = confirmPurchaseOrderCancellation(deps, request());

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.version).toBe(poBefore.version + 1);
    expect(cancelled.cancelledAt).toBe(NOW); // 서버 기록 시각
    expect(cancelled.lines).toEqual(poBefore.lines); // 원 발주 수량·연결 보존 (UC-09)
    expect(cancelled.delivery).toEqual(poBefore.delivery);
    expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(cancelled);
    // 취소 요청·회신 기록은 그대로 남는다
    expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(1);
    expect(deps.cancellations.listResponses("tenant-a", sent.id)).toHaveLength(1);
  });

  it("ACKNOWLEDGED 발주도 취소 확정할 수 있다", () => {
    const { sent, deps, poLineId, cancel, request } = scene();
    recordSupplierReply(deps, {
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId,
      kind: "CONFIRM",
      quantity: 1,
      evidence: "이메일",
      repliedAt: REPLIED_AT,
      idempotencyKey: "reply-1",
    });
    expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("ACKNOWLEDGED");
    cancel(poLineId, 6);

    expect(confirmPurchaseOrderCancellation(deps, request()).status).toBe("CANCELLED");
  });

  it("수락된 취소와 품절 확정이 합쳐 전량이 되어도 수락 근거가 있으면 취소 확정할 수 있다 (품절 2 + 수락 4 = 6)", () => {
    const { poLineId, deps, cancel, outOfStock, request } = scene();
    outOfStock(poLineId, 2);
    cancel(poLineId, 4);

    expect(confirmPurchaseOrderCancellation(deps, request()).status).toBe("CANCELLED");
  });

  describe("전량이 아니면 거절한다 (BUSINESS_INVARIANT, 발주는 그대로)", () => {
    function expectRejected(run: () => unknown, deps: ReturnType<typeof scene>["deps"], id: string) {
      const before = structuredClone(deps.purchaseOrders.get("tenant-a", id));

      const error = thrown(run);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(deps.purchaseOrders.get("tenant-a", id)).toEqual(before);
    }

    it("일부만 수락되어 유효 발주량이 남아 있으면 거절한다 (6권 중 5권 수락)", () => {
      const { sent, deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6, 5);

      expectRejected(() => confirmPurchaseOrderCancellation(deps, request()), deps, sent.id);
    });

    it("수락된 취소가 없으면(회신 없음, 요청만 있음) 거절한다: 요청만으로는 확정 취소가 아니다 (PO-010)", () => {
      const { sent, deps, poLineId, request } = scene();
      createCancellationRequest(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        poLineId,
        quantity: 6,
        reason: "고객 취소",
        idempotencyKey: "ask-1",
      });

      expectRejected(() => confirmPurchaseOrderCancellation(deps, request()), deps, sent.id);
    });

    it("전량 품절 확정만으로는 취소 확정할 수 없다: 취소 수락 근거가 아니다", () => {
      const { sent, deps, poLineId, outOfStock, request } = scene();
      outOfStock(poLineId, 6); // 유효 발주량은 0이지만 공급처가 취소를 수락한 것은 아니다

      expectRejected(() => confirmPurchaseOrderCancellation(deps, request()), deps, sent.id);
    });

    it("거절된 취소만 있으면 거절한다 (수락 0)", () => {
      const { sent, deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6, 0);

      expectRejected(() => confirmPurchaseOrderCancellation(deps, request()), deps, sent.id);
    });

    it("유효 발주량이 0이어도 수락된 응답이 하나도 없으면 거절한다 (요청 → 전량 품절 확정 → 거절 응답: 응답은 있지만 수락 근거는 아니다)", () => {
      const { sent, deps, poLineId, outOfStock, request } = scene();
      const asked = createCancellationRequest(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        poLineId,
        quantity: 6,
        reason: "고객 취소",
        idempotencyKey: "ask-1",
      });
      outOfStock(poLineId, 6); // 유효 발주량 0
      respondToCancellationRequest(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        cancellationRequestId: asked.id,
        acceptedQuantity: 0,
        rejectedQuantity: 6, // 공급처가 취소 요청을 거절함
        evidence: "공급처 회신",
        repliedAt: REPLIED_AT,
        idempotencyKey: "answer-1",
      });
      expect(deps.cancellations.listResponses("tenant-a", sent.id)).toHaveLength(1); // 응답은 존재한다

      expectRejected(() => confirmPurchaseOrderCancellation(deps, request()), deps, sent.id);
    });

    it("품목별 계산은 독립이다: 한 품목은 취소 수락으로, 다른 품목은 품절+수락으로 0이 되면 전량 취소가 가능하다", () => {
      const s = scene({ secondBook: true }); // 품목1 6권, 품목2 5권
      s.cancel(s.poLineId, 6); // 품목1: 수락 6
      s.outOfStock(s.secondPoLineId!, 2); // 품목2: 품절 2
      s.cancel(s.secondPoLineId!, 3); // 품목2: 수락 3 → 2 + 3 = 5

      // 품목2의 품절 2가 품목1의 계산에 섞이면 2 + 6 > 6이라 잘못 거절된다
      expect(confirmPurchaseOrderCancellation(s.deps, s.request()).status).toBe("CANCELLED");
    });

    it("품목이 여러 개일 때 한 품목이라도 유효 발주량이 남아 있으면 거절하고, 모두 0이면 허용한다", () => {
      const s = scene({ secondBook: true }); // 품목1 6권, 품목2 5권
      s.cancel(s.poLineId, 6); // 품목1만 전량 취소

      expectRejected(() => confirmPurchaseOrderCancellation(s.deps, s.request()), s.deps, s.sent.id);

      s.cancel(s.secondPoLineId!, 5); // 품목2도 전량 취소

      expect(confirmPurchaseOrderCancellation(s.deps, s.request()).status).toBe("CANCELLED");
    });
  });

  describe("취소 이후의 연쇄 효과 (슬라이스 간 통합)", () => {
    function cancelled() {
      const s = scene();
      s.cancel(s.poLineId, 6);
      const po = confirmPurchaseOrderCancellation(s.deps, s.request());
      return { ...s, po };
    }

    it("취소된 발주에는 회신·취소 요청·취소 회신이 모두 거절된다 (BUSINESS_INVARIANT 422)", () => {
      const { po, deps, poLineId } = cancelled();
      const attempts = [
        () =>
          recordSupplierReply(deps, {
            tenantId: "tenant-a",
            purchaseOrderId: po.id,
            poLineId,
            kind: "CONFIRM",
            quantity: 1,
            evidence: "이메일",
            repliedAt: REPLIED_AT,
            idempotencyKey: "late-reply",
          }),
        () =>
          createCancellationRequest(deps, {
            tenantId: "tenant-a",
            purchaseOrderId: po.id,
            poLineId,
            quantity: 1,
            reason: "추가",
            idempotencyKey: "late-ask",
          }),
        () =>
          respondToCancellationRequest(deps, {
            tenantId: "tenant-a",
            purchaseOrderId: po.id,
            cancellationRequestId: deps.cancellations.listRequests("tenant-a", po.id)[0]!.id,
            acceptedQuantity: 0,
            rejectedQuantity: 1,
            evidence: "늦은 응답",
            repliedAt: REPLIED_AT,
            idempotencyKey: "late-answer",
          }),
      ];

      for (const attempt of attempts) {
        const error = thrown(attempt);
        expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
        expect((error as AppError).httpStatus).toBe(422);
      }
      expect(deps.purchaseOrders.get("tenant-a", po.id)).toEqual(po); // 취소 상태 그대로
    });

    it("취소된 발주에 연결됐던 배정은 다시 연결할 수 있고, 취소된 발주는 이력으로 남는다 (배정 재연결)", () => {
      const { po, w, allocations } = cancelled();
      const ids = allocations.map((a) => a.id);

      const next = createPurchaseOrder(w.deps, w.request(ids)); // 같은 공급처로 재발주

      expect(next.status).toBe("DRAFT");
      expect(next.id).not.toBe(po.id);
      expect(next.lines[0]!.quantity).toBe(6); // 같은 배정 2+3+1
      expect(w.deps.purchaseOrders.get("tenant-a", po.id)!.status).toBe("CANCELLED"); // 원 발주는 이력으로 보존
    });

    it("취소 전에는 같은 배정을 다른 발주에 연결할 수 없다 (중복 재발주 방지)", () => {
      const { w, allocations, poLineId, cancel } = scene();
      cancel(poLineId, 6); // 요청·수락만으로는 확정 취소가 아니다: 발주는 아직 SENT

      const error = thrown(() => createPurchaseOrder(w.deps, w.request(allocations.map((a) => a.id))));

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
    });
  });

  describe("입력 검증 (조회보다 먼저 400, 발주는 그대로)", () => {
    it.each([
      ["purchaseOrderId 빈 문자열", { purchaseOrderId: "" }, /purchaseOrderId/],
      ["purchaseOrderId 공백", { purchaseOrderId: "  " }, /purchaseOrderId/],
      ["purchaseOrderId 누락", { purchaseOrderId: undefined }, /purchaseOrderId/],
      ["purchaseOrderId 숫자", { purchaseOrderId: 7 }, /purchaseOrderId/],
      ["expectedVersion 0", { expectedVersion: 0 }, /expectedVersion/],
      ["expectedVersion 음수", { expectedVersion: -1 }, /expectedVersion/],
      ["expectedVersion 소수", { expectedVersion: 1.5 }, /expectedVersion/],
      ["expectedVersion NaN", { expectedVersion: Number.NaN }, /expectedVersion/],
      ["expectedVersion 문자열", { expectedVersion: "3" }, /expectedVersion/],
      ["expectedVersion null", { expectedVersion: null }, /expectedVersion/],
      ["expectedVersion 누락", { expectedVersion: undefined }, /expectedVersion/],
    ])("%s → 400 VALIDATION_ERROR이고 발주는 그대로다", (_name, bad, field) => {
      const { sent, deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6);

      const error = thrown(() => confirmPurchaseOrderCancellation(deps, request(bad) as never));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(field);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");
    });
  });

  describe("멱등키: 되돌릴 수 없는 상태 전이이므로 중복 실행에 민감하다", () => {
    it("같은 키·같은 본문의 재시도는 이미 CANCELLED가 되었어도 같은 결과를 반환하고 버전이 한 번만 오른다", () => {
      const { sent, deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6);
      const body = request();

      const first = confirmPurchaseOrderCancellation(deps, body);
      const retry = confirmPurchaseOrderCancellation(deps, body); // 멱등이 아니면 CANCELLED라서 422

      expect(retry).toEqual(first);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.version).toBe(body.expectedVersion + 1);
    });

    it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이다", () => {
      const { deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6);
      const body = request();
      confirmPurchaseOrderCancellation(deps, body);

      const error = thrown(() =>
        confirmPurchaseOrderCancellation(deps, { ...body, expectedVersion: body.expectedVersion + 1 }),
      );

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
    });

    it.each(["", "   ", undefined])("멱등키가 비어 있으면(%j) 400이고 발주는 그대로다", (key) => {
      const { sent, deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6);

      const error = thrown(() => confirmPurchaseOrderCancellation(deps, request({ idempotencyKey: key }) as never));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/Idempotency-Key/);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");
    });
  });

  describe("사전조건", () => {
    it.each(["DRAFT", "READY", "CANCELLED"] as const)(
      "%s 발주는 취소 확정할 수 없다 → BUSINESS_INVARIANT(422)",
      (status) => {
        const { sent, deps, poLineId, cancel, request } = scene();
        cancel(poLineId, 6);
        deps.purchaseOrders.save({ ...sent, status, version: sent.version });

        const error = thrown(() => confirmPurchaseOrderCancellation(deps, request({ expectedVersion: sent.version })));

        expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
        expect((error as AppError).httpStatus).toBe(422);
        expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe(status);
      },
    );

    it("expectedVersion이 다르면 VERSION_CONFLICT(409)이고 발주는 그대로다", () => {
      const { sent, deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6);

      const error = thrown(() => confirmPurchaseOrderCancellation(deps, request({ expectedVersion: 99 })));

      expect((error as AppError).code).toBe("VERSION_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");
    });

    it("없는 발주와 타 테넌트의 발주는 구별할 수 없는 동일한 NOT_FOUND(404)이다", () => {
      const { sent, deps, poLineId, cancel, request } = scene();
      cancel(poLineId, 6);
      const missing = thrown(() =>
        confirmPurchaseOrderCancellation(deps, request({ purchaseOrderId: "00000000-0000-4000-8000-000000000000" })),
      );

      const crossTenant = thrown(() => confirmPurchaseOrderCancellation(deps, request({ tenantId: "tenant-b" })));

      expect((crossTenant as AppError).code).toBe("NOT_FOUND");
      expect((crossTenant as AppError).message).toBe((missing as AppError).message);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");
    });
  });
});
