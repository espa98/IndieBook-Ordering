import { describe, it, expect } from "vitest";
import { createCancellationRequest } from "../../src/procurement/createCancellationRequest";
import { cancellationRequestState } from "../../src/procurement/cancellationRequestState";
import { poLineState } from "../../src/procurement/poLineState";
import { respondToCancellationRequest } from "../../src/procurement/respondToCancellationRequest";
import { recordSupplierReply } from "../../src/procurement/recordSupplierReply";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { sentScene } from "../helpers/procurementWorld";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLIED_AT = "2026-03-04T05:30:00.000Z";

/** 발주 10권(고객 4+6)이 전달된 상태에서 4권 취소를 요청한 장면 (TC-77) */
function tc77() {
  const s = sentScene({ quantities: [4, 6] });
  const requested = createCancellationRequest(s.deps, {
    tenantId: "tenant-a",
    purchaseOrderId: s.sent.id,
    poLineId: s.poLineId,
    quantity: 4,
    reason: "고객 주문 취소",
    idempotencyKey: "cancel-1",
  });
  let n = 0;
  const respond = (extra: Record<string, unknown> = {}) =>
    respondToCancellationRequest(s.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      cancellationRequestId: requested.id,
      acceptedQuantity: 0,
      rejectedQuantity: 0,
      evidence: "공급처 이메일 회신",
      repliedAt: REPLIED_AT,
      idempotencyKey: `respond-${++n}`,
      ...extra,
    } as never);
  const responses = () => s.deps.cancellations.listResponses("tenant-a", s.sent.id);
  const requestState = () => cancellationRequestState(requested.quantity, responses());
  const lineState = () =>
    poLineState(
      s.sent.lines[0]!.quantity,
      s.deps.replies.list("tenant-a", s.sent.id),
      responses().reduce((sum, r) => sum + r.acceptedQuantity, 0),
    );
  return { ...s, requested, respond, responses, requestState, lineState };
}

describe("respondToCancellationRequest (ST-P08, BR-P02, DEC-04: 수락된 수량만 외부 의무를 차감한다)", () => {
  it("TC-77: 발주 10권, 취소 요청 4권에 수락 2·거절 1이면 유효 발주 8권이고 미응답 1이 REQUESTED로 남는다", () => {
    const { sent, deps, respond, requestState, lineState } = tc77();
    const poBefore = structuredClone(deps.purchaseOrders.get("tenant-a", sent.id));

    respond({ acceptedQuantity: 2 });
    respond({ rejectedQuantity: 1 });

    expect(requestState()).toEqual({
      requested: 4,
      accepted: 2,
      rejected: 1,
      unanswered: 1, // 요청 미응답 1 유지
      status: "REQUESTED",
    });
    expect(lineState()).toMatchObject({ qsend: 10, qreduce: 2, qvalid: 8 }); // 수락한 2만 차감
    // 요청 상태와 발주 상태는 독립이다 (BR-P02): 취소 회신이 발주를 바꾸지 않는다
    expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(poBefore);
  });

  it("응답은 별도 기록으로 쌓이고 원 요청을 참조한다 (원본 보존)", () => {
    const { sent, requested, respond, responses } = tc77();

    const response = respond({ acceptedQuantity: 2, rejectedQuantity: 1 });

    expect(response).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId: sent.lines[0]!.poLineId,
      requestId: requested.id, // 원 요청 참조
      acceptedQuantity: 2,
      rejectedQuantity: 1,
      evidence: "공급처 이메일 회신",
      repliedAt: REPLIED_AT,
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(responses()).toEqual([response]);
  });

  it("전부 수락하면 ACCEPTED, 전부 거절하면 REJECTED, 섞이면 PARTIALLY_ACCEPTED이다", () => {
    const a = tc77();
    a.respond({ acceptedQuantity: 4 });
    expect(a.requestState().status).toBe("ACCEPTED");
    expect(a.lineState()).toMatchObject({ qreduce: 4, qvalid: 6 });

    const r = tc77();
    r.respond({ rejectedQuantity: 4 });
    expect(r.requestState().status).toBe("REJECTED");
    expect(r.lineState()).toMatchObject({ qreduce: 0, qvalid: 10 }); // 거절은 차감하지 않는다

    const m = tc77();
    m.respond({ acceptedQuantity: 1, rejectedQuantity: 3 });
    expect(m.requestState().status).toBe("PARTIALLY_ACCEPTED");
  });

  describe("멱등키: 외부 의무를 줄이는 기록이므로 중복 실행이 곧 이중 차감이다", () => {
    it("같은 키·같은 본문의 재시도는 같은 응답을 반환하고, 응답이 쌓이거나 수량이 이중으로 차감되지 않는다", () => {
      const { respond, responses, requestState, lineState } = tc77();

      const first = respond({ acceptedQuantity: 3, idempotencyKey: "same" });
      const retry = respond({ acceptedQuantity: 3, idempotencyKey: "same" }); // 멱등이 아니면 3 + 3 > 4라 422

      expect(retry).toEqual(first);
      expect(responses()).toHaveLength(1);
      expect(requestState()).toMatchObject({ accepted: 3, unanswered: 1 });
      expect(lineState()).toMatchObject({ qreduce: 3, qvalid: 7 }); // 6이 아니다
    });

    it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이고 기록을 바꾸지 않는다", () => {
      const { respond, responses } = tc77();
      respond({ acceptedQuantity: 2, idempotencyKey: "same" });

      const error = thrown(() => respond({ acceptedQuantity: 1, idempotencyKey: "same" }));

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
      expect(responses()).toHaveLength(1);
    });

    it("다른 키로 보낸 같은 내용은 별개의 응답이다 (요청량 안에서는 허용)", () => {
      const { respond, responses } = tc77();

      respond({ acceptedQuantity: 1, idempotencyKey: "a" });
      respond({ acceptedQuantity: 1, idempotencyKey: "b" });

      expect(responses()).toHaveLength(2);
    });

    it.each(["", "   ", undefined])("멱등키가 비어 있으면(%j) 400이고 저장하지 않는다", (key) => {
      const { respond, responses } = tc77();

      const error = thrown(() => respond({ acceptedQuantity: 1, idempotencyKey: key }));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/Idempotency-Key/);
      expect(responses()).toHaveLength(0);
    });
  });

  describe("입력 검증 (외부 의무를 줄이는 기록이므로 엄격하다, 조회보다 먼저 400)", () => {
    it.each([
      // 음수 케이스는 합이 1 이상이어야 한다: 합이 0이면 '합 ≥ 1' 검사가 대신 걸려 음수 검사를 확인하지 못한다
      ["acceptedQuantity 음수", { acceptedQuantity: -1, rejectedQuantity: 3 }, /acceptedQuantity/],
      ["acceptedQuantity 소수", { acceptedQuantity: 1.5 }, /acceptedQuantity/],
      ["acceptedQuantity NaN", { acceptedQuantity: Number.NaN, rejectedQuantity: 1 }, /acceptedQuantity/],
      ["acceptedQuantity 문자열", { acceptedQuantity: "2" }, /acceptedQuantity/],
      ["acceptedQuantity null", { acceptedQuantity: null, rejectedQuantity: 1 }, /acceptedQuantity/],
      ["acceptedQuantity 누락", { acceptedQuantity: undefined, rejectedQuantity: 1 }, /acceptedQuantity/],
      ["rejectedQuantity 음수", { acceptedQuantity: 3, rejectedQuantity: -1 }, /rejectedQuantity/],
      ["rejectedQuantity 소수", { rejectedQuantity: 0.5, acceptedQuantity: 1 }, /rejectedQuantity/],
      ["rejectedQuantity 문자열", { acceptedQuantity: 1, rejectedQuantity: "1" }, /rejectedQuantity/],
      ["rejectedQuantity null", { acceptedQuantity: 1, rejectedQuantity: null }, /rejectedQuantity/],
      ["수락도 거절도 0 (의미 없는 응답)", { acceptedQuantity: 0, rejectedQuantity: 0 }, /acceptedQuantity|rejectedQuantity/],
      ["evidence 빈 문자열", { acceptedQuantity: 1, evidence: "" }, /evidence/],
      ["evidence 공백", { acceptedQuantity: 1, evidence: "   " }, /evidence/],
      ["evidence 누락", { acceptedQuantity: 1, evidence: undefined }, /evidence/],
      ["evidence 숫자", { acceptedQuantity: 1, evidence: 7 }, /evidence/],
      ["repliedAt 누락", { acceptedQuantity: 1, repliedAt: undefined }, /repliedAt/],
      ["repliedAt 날짜만", { acceptedQuantity: 1, repliedAt: "2026-03-04" }, /repliedAt/],
      ["repliedAt UTC 아님(+09:00)", { acceptedQuantity: 1, repliedAt: "2026-03-04T05:30:00+09:00" }, /repliedAt/],
      ["repliedAt 존재하지 않는 날짜", { acceptedQuantity: 1, repliedAt: "2026-13-45T00:00:00Z" }, /repliedAt/],
      ["repliedAt 미래(기록 시각보다 1초 뒤)", { acceptedQuantity: 1, repliedAt: "2026-03-04T07:00:01.000Z" }, /repliedAt/],
      ["purchaseOrderId 빈 문자열", { acceptedQuantity: 1, purchaseOrderId: "" }, /purchaseOrderId/],
      ["cancellationRequestId 빈 문자열", { acceptedQuantity: 1, cancellationRequestId: "  " }, /cancellationRequestId/],
    ])("%s → 400 VALIDATION_ERROR이고 저장하지 않는다", (_name, bad, field) => {
      const { respond, responses, lineState } = tc77();

      const error = thrown(() => respond(bad));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(field);
      expect(responses()).toHaveLength(0);
      expect(lineState()).toMatchObject({ qreduce: 0, qvalid: 10 });
    });

    it("수락 0 + 거절 N, 수락 N + 거절 0은 허용된다 (둘 중 하나만 있어도 된다)", () => {
      const a = tc77();
      const b = tc77();

      expect(() => a.respond({ acceptedQuantity: 2, rejectedQuantity: 0 })).not.toThrow();
      expect(() => b.respond({ acceptedQuantity: 0, rejectedQuantity: 2 })).not.toThrow();
    });

    it("repliedAt이 기록 시각과 같으면 허용하고, 밀리초가 없으면 정규화한다", () => {
      const { respond } = tc77();

      const response = respond({ acceptedQuantity: 1, repliedAt: "2026-03-04T07:00:00Z" });

      expect(response.repliedAt).toBe("2026-03-04T07:00:00.000Z");
    });
  });

  describe("사전조건: 대상이 없으면 구별할 수 없는 동일한 404, 상태가 맞지 않으면 422", () => {
    it("없는 발주, 타 테넌트의 발주, 없는 요청, 다른 발주의 요청, 타 테넌트의 요청은 모두 같은 NOT_FOUND이고 저장하지 않는다", () => {
      const { sent, requested, deps, respond, responses } = tc77();
      const other = sentScene(); // 별개의 발주와 요청
      const otherRequest = createCancellationRequest(other.deps, {
        tenantId: "tenant-a",
        purchaseOrderId: other.sent.id,
        poLineId: other.poLineId,
        quantity: 2,
        reason: "다른 발주",
        idempotencyKey: "other-cancel",
      });
      // 다른 발주의 요청과 타 테넌트의 요청을 이 장면의 저장소에 넣는다
      deps.cancellations.saveRequest(otherRequest);
      deps.cancellations.saveRequest({ ...requested, id: "11111111-1111-4111-8111-111111111111", tenantId: "tenant-b" });
      const missing = "00000000-0000-4000-8000-000000000000";

      const errors = [
        thrown(() => respond({ acceptedQuantity: 1, purchaseOrderId: missing })), // 없는 발주
        thrown(() => respond({ acceptedQuantity: 1, tenantId: "tenant-b" })), // 타 테넌트가 이 발주 ID로 접근
        thrown(() => respond({ acceptedQuantity: 1, cancellationRequestId: missing })), // 없는 요청
        thrown(() => respond({ acceptedQuantity: 1, cancellationRequestId: otherRequest.id })), // 다른 발주의 요청
        thrown(() => respond({ acceptedQuantity: 1, cancellationRequestId: "11111111-1111-4111-8111-111111111111" })), // 타 테넌트의 요청
      ];

      for (const error of errors) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("NOT_FOUND");
        expect((error as AppError).httpStatus).toBe(404);
      }
      expect(new Set(errors.map((e) => (e as AppError).message)).size).toBe(1); // 어떤 경우인지 구별할 수 없다
      expect(responses()).toHaveLength(0);
      expect(sent.id).toBeTruthy();
    });

    it.each(["DRAFT", "READY", "CANCELLED"] as const)(
      "%s 발주의 요청에는 응답할 수 없다 → BUSINESS_INVARIANT(422)이고 저장하지 않는다",
      (status) => {
        const { sent, deps, respond, responses } = tc77();
        deps.purchaseOrders.save({ ...sent, status });

        const error = thrown(() => respond({ acceptedQuantity: 1 }));

        expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
        expect((error as AppError).httpStatus).toBe(422);
        expect(responses()).toHaveLength(0);
      },
    );
  });

  describe("요청량을 넘는 응답은 거절한다 (BR-P02: 중복 회신 차단)", () => {
    it("이미 응답한 수량과 합쳐 요청량을 넘으면 422이고 저장하지 않는다 (수락 3 후 수락 2: 5 > 4)", () => {
      const { respond, responses, requestState } = tc77();
      respond({ acceptedQuantity: 3 });

      const error = thrown(() => respond({ acceptedQuantity: 2 }));

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(responses()).toHaveLength(1);
      expect(requestState()).toMatchObject({ accepted: 3, unanswered: 1 });
    });

    it("한 번의 응답에서 수락 + 거절이 요청량을 넘어도 거절한다 (3 + 2 > 4)", () => {
      const { respond, responses } = tc77();

      expect(() => respond({ acceptedQuantity: 3, rejectedQuantity: 2 })).toThrow(/BUSINESS_INVARIANT/);
      expect(responses()).toHaveLength(0);
    });

    it("이미 모두 응답한 요청에 또 응답하면 거절한다", () => {
      const { respond } = tc77();
      respond({ acceptedQuantity: 4 });

      expect(() => respond({ rejectedQuantity: 1 })).toThrow(/BUSINESS_INVARIANT/);
    });

    it("요청량과 정확히 같게 응답하는 것은 허용한다 (경계값)", () => {
      const { respond, requestState } = tc77();

      respond({ acceptedQuantity: 2 });
      respond({ rejectedQuantity: 2 });

      expect(requestState()).toMatchObject({ unanswered: 0, status: "PARTIALLY_ACCEPTED" });
    });
  });

  describe("품절 확정과 수락된 취소가 합쳐 발주 수량을 넘으면 거절한다 (BR-P01: 이중 차감 방지)", () => {
    it("요청 후 공급처가 품절 8권을 확정했다면, 취소 4권 수락은 8 + 4 > 10이라 422이고 저장하지 않는다", () => {
      const { sent, deps, respond, responses, lineState } = tc77(); // 요청 4권이 미응답으로 열려 있다
      recordSupplierReply(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        poLineId: sent.lines[0]!.poLineId,
        kind: "OUT_OF_STOCK",
        quantity: 8,
        evidence: "공급처 이메일 (품절 확정)",
        repliedAt: REPLIED_AT,
        idempotencyKey: "oos-1",
      });

      const error = thrown(() => respond({ acceptedQuantity: 4 }));

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(responses()).toHaveLength(0);
      expect(lineState()).toMatchObject({ outOfStock: 8, qreduce: 8, qvalid: 2 }); // 수락은 반영되지 않았다
    });

    it("합이 정확히 발주 수량이면 허용한다 (품절 6 + 수락 4 = 10, 유효 발주 0권)", () => {
      const { sent, deps, respond, lineState } = tc77();
      recordSupplierReply(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        poLineId: sent.lines[0]!.poLineId,
        kind: "OUT_OF_STOCK",
        quantity: 6,
        evidence: "공급처 이메일",
        repliedAt: REPLIED_AT,
        idempotencyKey: "oos-1",
      });

      respond({ acceptedQuantity: 4 });

      expect(lineState()).toMatchObject({ qreduce: 10, qvalid: 0 });
    });
  });

  describe("요청·품목이 여러 개여도 서로 독립이고, 수락은 누적된다", () => {
    const answer = (
      s: ReturnType<typeof sentScene>,
      requestId: string,
      extra: Record<string, unknown>,
      key: string,
    ) =>
      respondToCancellationRequest(s.deps, {
        tenantId: "tenant-a",
        purchaseOrderId: s.sent.id,
        cancellationRequestId: requestId,
        acceptedQuantity: 0,
        rejectedQuantity: 0,
        evidence: "공급처 회신",
        repliedAt: REPLIED_AT,
        idempotencyKey: key,
        ...extra,
      } as never);
    const ask = (s: ReturnType<typeof sentScene>, poLineId: string, quantity: number, key: string) =>
      createCancellationRequest(s.deps, {
        tenantId: "tenant-a",
        purchaseOrderId: s.sent.id,
        poLineId,
        quantity,
        reason: "사유",
        idempotencyKey: key,
      });
    const oos = (s: ReturnType<typeof sentScene>, poLineId: string, quantity: number, key: string) =>
      recordSupplierReply(s.deps, {
        tenantId: "tenant-a",
        purchaseOrderId: s.sent.id,
        poLineId,
        kind: "OUT_OF_STOCK",
        quantity,
        evidence: "공급처 이메일",
        repliedAt: REPLIED_AT,
        idempotencyKey: key,
      });

    it("수락은 누적된다: 이전에 수락한 수량도 품절과 합쳐 Qsend를 넘는지 확인한다 (수락 2 + 품절 8 + 수락 1 = 11 > 10)", () => {
      const s = sentScene({ quantities: [4, 6] }); // 10권
      const request = ask(s, s.poLineId, 4, "c-1");
      answer(s, request.id, { acceptedQuantity: 2 }, "r-1");
      oos(s, s.poLineId, 8, "oos-1"); // 수락 2 + 품절 8 = 10: 정확히 가득

      const error = thrown(() => answer(s, request.id, { acceptedQuantity: 1 }, "r-2")); // 11 > 10

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect(s.deps.cancellations.listResponses("tenant-a", s.sent.id)).toHaveLength(1);
    });

    it("같은 품목의 요청 여러 개는 서로의 응답 계산에 영향을 주지 않는다", () => {
      const s = sentScene({ quantities: [4, 6] }); // 10권
      const r1 = ask(s, s.poLineId, 4, "c-1");
      const r2 = ask(s, s.poLineId, 2, "c-2");

      answer(s, r1.id, { acceptedQuantity: 4 }, "r-1"); // 요청 1을 모두 수락
      // 요청 2(2권)는 요청 1의 응답과 무관하게 자기 요청량(2)까지 응답할 수 있다
      expect(() => answer(s, r2.id, { acceptedQuantity: 2 }, "r-2")).not.toThrow();
      expect(s.deps.cancellations.listResponses("tenant-a", s.sent.id)).toHaveLength(2);
    });

    it("품목이 여러 개여도 독립이다: 한 품목의 품절·수락이 다른 품목의 수락 가능 수량을 줄이지 않는다", () => {
      const s = sentScene({ quantities: [4, 6], secondBook: true }); // 품목1 10권, 품목2 5권
      const r1 = ask(s, s.poLineId, 6, "c-1");
      const r2 = ask(s, s.secondPoLineId!, 5, "c-2");
      oos(s, s.secondPoLineId!, 5, "oos-2"); // 품목2는 전량 품절 확정 (품목1과 무관)

      // 품목1 수락 6: 품목1 기준으로는 6 ≤ 10이다. 품목2의 품절 5가 섞이면 5 + 6 = 11 > 10이라 잘못 거절된다
      expect(() => answer(s, r1.id, { acceptedQuantity: 6 }, "r-1")).not.toThrow();
      expect(s.deps.cancellations.listResponses("tenant-a", s.sent.id)).toHaveLength(1);

      // 품목2는 자기 품목의 합(품절 5)만 보므로 수락 5는 5 + 5 > 5라 거절, 품목1의 수락 4가 영향을 주지 않는다
      const error = thrown(() => answer(s, r2.id, { acceptedQuantity: 5 }, "r-2"));
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
    });

    it("품목별 수락 합은 각자 계산한다: 품목1 수락 4 + 품목2 수락 5가 각자의 수량 안에서 모두 허용된다", () => {
      const s = sentScene({ quantities: [4, 6], secondBook: true }); // 10권, 5권
      const r1 = ask(s, s.poLineId, 4, "c-1");
      const r2 = ask(s, s.secondPoLineId!, 5, "c-2");

      answer(s, r1.id, { acceptedQuantity: 4 }, "r-1");
      expect(() => answer(s, r2.id, { acceptedQuantity: 5 }, "r-2")).not.toThrow(); // 4 + 5 = 9는 품목별이 아니라 합산하면 5 초과
    });
  });

  describe("수락·거절이 요청 가능 수량에 반영된다", () => {
    it("수락은 가용 수량을 줄이고 거절은 되돌린다 (TC-77 이후: Qvalid 8 − 미응답 1 = 7권까지 요청 가능)", () => {
      const { sent, deps, respond } = tc77();
      respond({ acceptedQuantity: 2 });
      respond({ rejectedQuantity: 1 });
      const again = (quantity: number, key: string) =>
        createCancellationRequest(deps, {
          tenantId: "tenant-a",
          purchaseOrderId: sent.id,
          poLineId: sent.lines[0]!.poLineId,
          quantity,
          reason: "추가 취소",
          idempotencyKey: key,
        });

      expect(() => again(8, "c-8")).toThrow(/BUSINESS_INVARIANT/); // 8 > 7
      expect(() => again(7, "c-7")).not.toThrow(); // 경계값
    });
  });
});
