import { describe, it, expect } from "vitest";
import { createCancellationRequest } from "../../src/procurement/createCancellationRequest";
import { cancellationRequestState } from "../../src/procurement/cancellationRequestState";
import { poLineState } from "../../src/procurement/poLineState";
import { recordSupplierReply } from "../../src/procurement/recordSupplierReply";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { sentScene } from "../helpers/procurementWorld";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scene() {
  const s = sentScene(); // 발주 품목 6권 (2+3+1)
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: s.sent.id,
    poLineId: s.poLineId,
    quantity: 4,
    reason: "고객 3명 중 2명이 주문을 취소함",
    idempotencyKey: "cancel-1",
    ...extra,
  });
  const reply = (extra: Record<string, unknown> = {}) =>
    recordSupplierReply(
      { ...s.deps },
      {
        tenantId: "tenant-a",
        purchaseOrderId: s.sent.id,
        poLineId: s.poLineId,
        kind: "CONFIRM",
        quantity: 1,
        evidence: "이메일",
        repliedAt: "2026-03-04T05:30:00.000Z",
        idempotencyKey: `reply-${Math.random()}`,
        ...extra,
      } as never,
    );
  /** 저장된 회신으로 계산한 발주 품목 상태 */
  const lineState = () =>
    poLineState(s.sent.lines[0]!.quantity, s.deps.replies.list("tenant-a", s.sent.id));
  return { ...s, request, reply, lineState };
}

describe("createCancellationRequest (ST-P08: 변경·취소 요청, 원본 보존)", () => {
  it("취소 요청을 별도 기록으로 남기고, 발주 수량·상태·버전은 한 글자도 바꾸지 않는다 (PO-010)", () => {
    const { sent, deps, request, lineState } = scene();
    const poBefore = structuredClone(deps.purchaseOrders.get("tenant-a", sent.id));
    const stateBefore = lineState();

    const created = createCancellationRequest(deps, request());

    expect(created).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId: sent.lines[0]!.poLineId,
      quantity: 4,
      reason: "고객 3명 중 2명이 주문을 취소함",
      requestedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(deps.cancellations.getRequest("tenant-a", created.id)).toEqual(created);
    // 요청만으로는 확정 취소가 아니다: 발주도, 유효 발주량도 그대로다
    expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(poBefore);
    expect(lineState()).toEqual(stateBefore);
    expect(lineState()).toMatchObject({ qreduce: 0, qvalid: 6 });
  });

  it("방금 만든 요청은 REQUESTED이고 미응답이 요청량과 같다", () => {
    const { deps, request } = scene();

    const created = createCancellationRequest(deps, request());

    expect(cancellationRequestState(created.quantity, [])).toMatchObject({
      status: "REQUESTED",
      unanswered: 4,
      accepted: 0,
      rejected: 0,
    });
  });

  it("ACKNOWLEDGED 발주에도 요청할 수 있다", () => {
    const { sent, deps, request, reply } = scene();
    reply(); // 회신으로 ACKNOWLEDGED가 된다
    expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("ACKNOWLEDGED");

    expect(() => createCancellationRequest(deps, request())).not.toThrow();
  });

  describe("요청 가능 수량 = 현재 Qvalid − 미응답 기존 요청량 (같은 수량을 두 번 요청해 이중 차감하지 않는다)", () => {
    it("합이 품목 수량을 넘는 요청은 BUSINESS_INVARIANT(422)이고 저장하지 않는다 (4 + 3 > 6)", () => {
      const { sent, deps, request } = scene(); // 품목 6권
      createCancellationRequest(deps, request({ quantity: 4, idempotencyKey: "c-1" }));

      const error = thrown(() => createCancellationRequest(deps, request({ quantity: 3, idempotencyKey: "c-2" })));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(1);
    });

    it("합이 정확히 품목 수량과 같으면 허용한다 (4 + 2 = 6, 경계값)", () => {
      const { sent, deps, request } = scene();
      createCancellationRequest(deps, request({ quantity: 4, idempotencyKey: "c-1" }));

      expect(() => createCancellationRequest(deps, request({ quantity: 2, idempotencyKey: "c-2" }))).not.toThrow();
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(2);
    });

    it("한 요청이 발주 수량을 넘으면 거절한다 (7 > 6)", () => {
      const { deps, request } = scene();

      expect(() => createCancellationRequest(deps, request({ quantity: 7 }))).toThrow(/BUSINESS_INVARIANT/);
    });

    it("품절로 확정된 수량은 요청 가능 수량을 줄인다 (품절 2권 → Qvalid 4 → 5권 요청은 거절, 4권은 허용)", () => {
      const { deps, request, reply } = scene();
      reply({ kind: "OUT_OF_STOCK", quantity: 2 });

      expect(() => createCancellationRequest(deps, request({ quantity: 5, idempotencyKey: "c-1" }))).toThrow(
        /BUSINESS_INVARIANT/,
      );
      expect(() => createCancellationRequest(deps, request({ quantity: 4, idempotencyKey: "c-2" }))).not.toThrow();
    });

    it("지연·확정 회신은 요청 가능 수량을 줄이지 않는다 (Qvalid가 그대로)", () => {
      const { deps, request, reply } = scene();
      reply({ kind: "CONFIRM", quantity: 2 });
      reply({ kind: "DELAY", quantity: 2, eta: "2026-03-20" });

      expect(() => createCancellationRequest(deps, request({ quantity: 6 }))).not.toThrow();
    });

    it("가용 수량은 품목별이다: 한 품목이 가득 차도 다른 품목은 요청할 수 있다", () => {
      const s = sentScene({ secondBook: true });
      const base = { tenantId: "tenant-a", purchaseOrderId: s.sent.id, reason: "사유" };

      createCancellationRequest(s.deps, { ...base, poLineId: s.poLineId, quantity: 6, idempotencyKey: "c-1" });

      expect(() =>
        createCancellationRequest(s.deps, { ...base, poLineId: s.secondPoLineId!, quantity: 5, idempotencyKey: "c-2" }),
      ).not.toThrow();
      expect(() =>
        createCancellationRequest(s.deps, { ...base, poLineId: s.poLineId, quantity: 1, idempotencyKey: "c-3" }),
      ).toThrow(/BUSINESS_INVARIANT/);
    });
  });

  describe("입력 검증 (조회·가용 수량 검사보다 먼저, 400)", () => {
    it.each([
      ["quantity 0", { quantity: 0 }, /quantity/],
      ["quantity 음수", { quantity: -1 }, /quantity/],
      ["quantity 소수", { quantity: 1.5 }, /quantity/],
      ["quantity NaN", { quantity: Number.NaN }, /quantity/],
      ["quantity 문자열", { quantity: "2" }, /quantity/],
      ["quantity null", { quantity: null }, /quantity/],
      ["quantity 누락", { quantity: undefined }, /quantity/],
      ["reason 빈 문자열", { reason: "" }, /reason/],
      ["reason 공백", { reason: "   " }, /reason/],
      ["reason 누락", { reason: undefined }, /reason/],
      ["reason 숫자", { reason: 7 }, /reason/],
      ["purchaseOrderId 빈 문자열", { purchaseOrderId: "" }, /purchaseOrderId/],
      ["poLineId 빈 문자열", { poLineId: "  " }, /poLineId/],
    ])("%s → 400 VALIDATION_ERROR이고 저장하지 않는다", (_name, bad, field) => {
      const { sent, deps, request } = scene();

      const error = thrown(() => createCancellationRequest(deps, request(bad) as never));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(field);
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(0);
    });
  });

  describe("멱등키", () => {
    it("같은 키·같은 본문의 재시도는 같은 요청을 반환하고, 가용 수량에 이중으로 계산되지 않는다", () => {
      const { sent, deps, request } = scene(); // 품목 6권

      const first = createCancellationRequest(deps, request({ quantity: 4 }));
      const retry = createCancellationRequest(deps, request({ quantity: 4 })); // 이중 계산이면 4 + 4 > 6으로 422

      expect(retry).toEqual(first);
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(1);
    });

    it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이고 새 요청을 만들지 않는다", () => {
      const { sent, deps, request } = scene();
      createCancellationRequest(deps, request({ quantity: 2 }));

      const error = thrown(() => createCancellationRequest(deps, request({ quantity: 3 })));

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(1);
    });

    it("같은 키에 사유만 다르면 IDEMPOTENCY_CONFLICT(409)이다 (다른 요청을 이전 요청으로 오인하지 않는다)", () => {
      const { sent, deps, request } = scene();
      createCancellationRequest(deps, request({ reason: "고객 취소" }));

      const error = thrown(() => createCancellationRequest(deps, request({ reason: "재고 부족" })));

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(1);
    });

    it("같은 키에 품목만 다르면 IDEMPOTENCY_CONFLICT(409)이다 (다른 품목의 취소가 조용히 무시되지 않는다)", () => {
      const s = sentScene({ secondBook: true });
      const base = { tenantId: "tenant-a", purchaseOrderId: s.sent.id, quantity: 2, reason: "사유", idempotencyKey: "same-key" };
      createCancellationRequest(s.deps, { ...base, poLineId: s.poLineId });

      const error = thrown(() => createCancellationRequest(s.deps, { ...base, poLineId: s.secondPoLineId! }));

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect(s.deps.cancellations.listRequests("tenant-a", s.sent.id)).toHaveLength(1);
    });

    it("같은 키에 다른 발주를 보내면 IDEMPOTENCY_CONFLICT(409)이다", () => {
      const { sent, deps, request } = scene();
      createCancellationRequest(deps, request());

      const error = thrown(() =>
        createCancellationRequest(deps, request({ purchaseOrderId: "00000000-0000-4000-8000-000000000000" })),
      );

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(1);
    });

    it.each(["", "   ", undefined])("멱등키가 비어 있으면(%j) 400이고 저장하지 않는다", (key) => {
      const { sent, deps, request } = scene();

      const error = thrown(() => createCancellationRequest(deps, request({ idempotencyKey: key }) as never));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/Idempotency-Key/);
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(0);
    });
  });

  describe("사전조건", () => {
    it.each(["DRAFT", "READY", "CANCELLED"] as const)(
      "%s 발주에는 요청할 수 없다 → BUSINESS_INVARIANT(422)이고 저장하지 않는다",
      (status) => {
        const { sent, deps, request } = scene();
        deps.purchaseOrders.save({ ...sent, status });

        const error = thrown(() => createCancellationRequest(deps, request()));

        expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
        expect((error as AppError).httpStatus).toBe(422);
        expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(0);
      },
    );

    it("없는 발주와 타 테넌트의 발주는 구별할 수 없는 동일한 NOT_FOUND(404)이다", () => {
      const { sent, deps, request } = scene();
      const missing = thrown(() =>
        createCancellationRequest(deps, request({ purchaseOrderId: "00000000-0000-4000-8000-000000000000" })),
      );

      const crossTenant = thrown(() => createCancellationRequest(deps, request({ tenantId: "tenant-b" })));

      expect((crossTenant as AppError).code).toBe("NOT_FOUND");
      expect((crossTenant as AppError).message).toBe((missing as AppError).message);
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(0);
    });

    it("이 발주에 속하지 않은 품목은 NOT_FOUND(404)이다", () => {
      const { sent, deps, request } = scene();

      const error = thrown(() =>
        createCancellationRequest(deps, request({ poLineId: "00000000-0000-4000-8000-000000000000" })),
      );

      expect((error as AppError).code).toBe("NOT_FOUND");
      expect(deps.cancellations.listRequests("tenant-a", sent.id)).toHaveLength(0);
    });
  });
});
