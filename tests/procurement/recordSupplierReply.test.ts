import { describe, it, expect } from "vitest";
import { recordSupplierReply } from "../../src/procurement/recordSupplierReply";
import { createCancellationRequest } from "../../src/procurement/createCancellationRequest";
import { respondToCancellationRequest } from "../../src/procurement/respondToCancellationRequest";
import { poLineState } from "../../src/procurement/poLineState";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { sentScene } from "../helpers/procurementWorld";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLIED_AT = "2026-03-04T05:30:00.000Z"; // 실제 회신 시각 (기록 시각 07:00보다 이전)

function scene() {
  const s = sentScene();
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: s.sent.id,
    poLineId: s.poLineId,
    kind: "CONFIRM" as const,
    quantity: 4,
    evidence: "공급처 이메일 회신 (제목: RE: 발주 확인)",
    repliedAt: REPLIED_AT,
    idempotencyKey: "reply-1",
    ...extra,
  });
  /** 저장된 회신 이벤트로 계산한 발주 품목 수량 상태 */
  const state = () =>
    poLineState(s.sent.lines[0]!.quantity, s.deps.replies.list("tenant-a", s.sent.id));
  return { ...s, request, state };
}

describe("recordSupplierReply (ST-P07: SENT → ACKNOWLEDGED, 공급처 회신)", () => {
  it("증빙 있는 첫 회신은 SENT를 ACKNOWLEDGED로 바꾸고, 회신은 별도 기록으로 남으며 발주 본문·전달 기록은 그대로다", () => {
    const { sent, deps, request, state } = scene();
    const before = structuredClone(sent);

    const reply = recordSupplierReply(deps, request());

    expect(reply).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId: sent.lines[0]!.poLineId,
      kind: "CONFIRM",
      quantity: 4,
      evidence: "공급처 이메일 회신 (제목: RE: 발주 확인)",
      repliedAt: REPLIED_AT, // 업무 발생 시각
      recordedAt: "2026-03-04T07:00:00.000Z", // 서버 기록 시각
    });
    const po = deps.purchaseOrders.get("tenant-a", sent.id)!;
    expect(po.status).toBe("ACKNOWLEDGED");
    expect(po.version).toBe(sent.version + 1);
    expect(po.lines).toEqual(sent.lines); // 품목·연결은 그대로 (원본 보존)
    expect(po.delivery).toEqual(sent.delivery); // 전달 기록도 그대로
    expect(sent).toEqual(before); // 원본 객체 불변
    expect(state()).toMatchObject({ confirmed: 4, unanswered: 2, qvalid: 6 });
  });

  describe("멱등키: 수량을 소진하는 기록이므로 중복 실행이 곧 이중 사용이다", () => {
    it("같은 키·같은 본문의 재시도는 같은 회신을 반환하고, 회신이 이중으로 쌓이지 않으며 수량을 다시 쓰지 않는다", () => {
      const { sent, deps, request, state } = scene();

      const first = recordSupplierReply(deps, request({ quantity: 2 }));
      const retry = recordSupplierReply(deps, request({ quantity: 2 })); // 같은 키·같은 본문

      expect(retry).toEqual(first);
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(1);
      expect(state()).toMatchObject({ confirmed: 2, unanswered: 4 }); // 4가 아니다
    });

    it("재시도가 풀 부족으로 거절되지 않는다 (멱등이 아니면 4+4 > 6이라 422)", () => {
      const { deps, request } = scene();
      const first = recordSupplierReply(deps, request({ quantity: 4 }));

      expect(recordSupplierReply(deps, request({ quantity: 4 }))).toEqual(first);
    });

    it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이고 새 회신을 만들지 않는다", () => {
      const { sent, deps, request } = scene();
      recordSupplierReply(deps, request({ quantity: 2 }));

      const error = thrown(() => recordSupplierReply(deps, request({ quantity: 3 })));

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(1);
    });

    it("다른 키로 보낸 같은 내용은 별개의 회신이다 (수량 불변식만 지키면 허용)", () => {
      const { sent, deps, request } = scene();

      recordSupplierReply(deps, request({ quantity: 2, idempotencyKey: "reply-1" }));
      recordSupplierReply(deps, request({ quantity: 2, idempotencyKey: "reply-2" }));

      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(2);
    });

    it.each(["", "   ", undefined])("멱등키가 비어 있으면(%j) 400이고 발주는 SENT 그대로다", (key) => {
      const { sent, deps, request } = scene();

      const error = thrown(() => recordSupplierReply(deps, request({ idempotencyKey: key }) as never));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/Idempotency-Key/);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(sent);
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(0);
    });
  });

  describe("회신 필드 검증 (외부 사실의 증거이므로 엄격하다)", () => {
    it.each([
      ["kind 허용되지 않은 값", { kind: "REFUSE" }, /kind/],
      ["kind 대소문자 다름", { kind: "confirm" }, /kind/],
      ["kind 누락", { kind: undefined }, /kind/],
      ["kind 숫자", { kind: 7 }, /kind/],
      ["quantity 0", { quantity: 0 }, /quantity/],
      ["quantity 음수", { quantity: -1 }, /quantity/],
      ["quantity 소수", { quantity: 1.5 }, /quantity/],
      ["quantity NaN", { quantity: Number.NaN }, /quantity/],
      ["quantity 문자열", { quantity: "2" }, /quantity/],
      ["quantity null", { quantity: null }, /quantity/],
      ["quantity 누락", { quantity: undefined }, /quantity/],
      ["source 허용되지 않은 값", { source: "SENT" }, /source/],
      ["source 소문자", { source: "delayed" }, /source/],
      ["source null", { source: null }, /source/],
      ["DELAY의 source=DELAYED (지연을 또 지연)", { kind: "DELAY", eta: "2026-03-20", source: "DELAYED" }, /source/],
      ["DELAY인데 eta 누락", { kind: "DELAY", eta: undefined }, /eta/],
      ["eta 존재하지 않는 날짜", { kind: "DELAY", eta: "2026-13-01" }, /eta/],
      ["eta 슬래시 형식", { kind: "DELAY", eta: "2026/03/20" }, /eta/],
      ["eta 시각 포함", { kind: "DELAY", eta: "2026-03-20T00:00:00Z" }, /eta/],
      ["eta 임의 문자열", { kind: "DELAY", eta: "tomorrow" }, /eta/],
      ["eta 빈 문자열", { kind: "CONFIRM", eta: "" }, /eta/],
      ["eta 숫자", { kind: "CONFIRM", eta: 20260320 }, /eta/],
      ["OUT_OF_STOCK에 eta (입고 예정이 있으면 품절이 아니라 지연)", { kind: "OUT_OF_STOCK", eta: "2026-03-20" }, /eta/],
      ["evidence 빈 문자열", { evidence: "" }, /evidence/],
      ["evidence 공백", { evidence: "   " }, /evidence/],
      ["evidence 누락", { evidence: undefined }, /evidence/],
      ["evidence 숫자", { evidence: 7 }, /evidence/],
      ["repliedAt 누락", { repliedAt: undefined }, /repliedAt/],
      ["repliedAt 빈 문자열", { repliedAt: "" }, /repliedAt/],
      ["repliedAt 날짜만", { repliedAt: "2026-03-04" }, /repliedAt/],
      ["repliedAt UTC 아님(+09:00)", { repliedAt: "2026-03-04T05:30:00+09:00" }, /repliedAt/],
      ["repliedAt 날짜가 아님", { repliedAt: "not a date" }, /repliedAt/],
      ["repliedAt 존재하지 않는 날짜", { repliedAt: "2026-13-45T00:00:00Z" }, /repliedAt/],
      ["repliedAt 미래(기록 시각보다 1초 뒤)", { repliedAt: "2026-03-04T07:00:01.000Z" }, /repliedAt/],
      ["purchaseOrderId 빈 문자열", { purchaseOrderId: "" }, /purchaseOrderId/],
      ["poLineId 빈 문자열", { poLineId: "  " }, /poLineId/],
    ])("%s → 400 VALIDATION_ERROR이고 발주는 SENT 그대로, 회신은 저장되지 않는다", (_name, bad, field) => {
      const { sent, deps, request } = scene();

      const error = thrown(() => recordSupplierReply(deps, request(bad) as never));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(field);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(sent);
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(0);
    });

    it("정상 조합은 허용된다: DELAY+eta, CONFIRM+eta, 이후 CONFIRM(source=DELAYED)", () => {
      const { deps, request, state } = scene();

      recordSupplierReply(deps, request({ kind: "DELAY", quantity: 4, eta: "2026-03-20", idempotencyKey: "r-1" }));
      recordSupplierReply(deps, request({ kind: "CONFIRM", quantity: 2, eta: "2026-03-10", idempotencyKey: "r-2" }));
      recordSupplierReply(deps, request({ kind: "CONFIRM", quantity: 4, source: "DELAYED", idempotencyKey: "r-3" }));

      expect(state()).toMatchObject({ delayed: 0, confirmed: 6, unanswered: 0 });
      expect(deps.replies.list("tenant-a", deps.purchaseOrders.list("tenant-a")[0]!.id)[0]!.eta).toBe("2026-03-20");
    });

    it("repliedAt이 기록 시각과 같으면 허용하고, 밀리초가 없으면 정규화한다", () => {
      const { deps, request } = scene();

      const reply = recordSupplierReply(deps, request({ repliedAt: "2026-03-04T07:00:00Z" }));

      expect(reply.repliedAt).toBe("2026-03-04T07:00:00.000Z");
    });
  });

  describe("사전조건: 회신은 SENT/ACKNOWLEDGED 발주의 품목에만 기록한다", () => {
    it.each(["DRAFT", "READY", "CANCELLED"] as const)(
      "%s 발주에는 회신할 수 없다 → BUSINESS_INVARIANT(422)이고 저장하지 않는다",
      (status) => {
        const { sent, deps, request } = scene();
        deps.purchaseOrders.save({ ...sent, status });

        const error = thrown(() => recordSupplierReply(deps, request()));

        expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
        expect((error as AppError).httpStatus).toBe(422);
        expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(0);
        expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe(status);
      },
    );

    it("없는 발주와 타 테넌트의 발주는 구별할 수 없는 동일한 NOT_FOUND(404)이다", () => {
      const { sent, deps, request } = scene();
      const missing = thrown(() =>
        recordSupplierReply(deps, request({ purchaseOrderId: "00000000-0000-4000-8000-000000000000" })),
      );

      const crossTenant = thrown(() => recordSupplierReply(deps, request({ tenantId: "tenant-b" })));

      expect((crossTenant as AppError).code).toBe("NOT_FOUND");
      expect((crossTenant as AppError).httpStatus).toBe(404);
      expect((crossTenant as AppError).message).toBe((missing as AppError).message);
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(0);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");
    });

    it("이 발주에 속하지 않은 품목은 NOT_FOUND(404)이다", () => {
      const { sent, deps, request } = scene();

      const error = thrown(() =>
        recordSupplierReply(deps, request({ poLineId: "00000000-0000-4000-8000-000000000000" })),
      );

      expect((error as AppError).code).toBe("NOT_FOUND");
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(0);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");
    });
  });

  describe("수량 불변식과 실패 시 원자성", () => {
    it("첫 회신이 수량 초과로 거절되면 발주는 ACKNOWLEDGED가 되지 않고 회신도 저장되지 않는다", () => {
      const { sent, deps, request } = scene(); // 품목 6권

      const error = thrown(() => recordSupplierReply(deps, request({ quantity: 7 })));

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(sent); // 여전히 SENT, 버전 그대로
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(0);
    });

    it("이미 분류한 수량을 넘는 후속 회신은 거절하고 기존 상태를 바꾸지 않는다", () => {
      const { sent, deps, request, state } = scene();
      recordSupplierReply(deps, request({ quantity: 4 }));
      const afterFirst = deps.purchaseOrders.get("tenant-a", sent.id)!;

      const error = thrown(() =>
        recordSupplierReply(deps, request({ kind: "OUT_OF_STOCK", quantity: 3, idempotencyKey: "reply-2" })),
      ); // 미응답은 2권뿐

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(1);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(afterFirst);
      expect(state()).toMatchObject({ confirmed: 4, unanswered: 2 });
    });

    it("수량 계산은 품목별로 독립이다: 한 품목의 회신이 다른 품목의 가능 수량을 줄이지 않는다", () => {
      const s = sentScene({ secondBook: true });
      const base = {
        tenantId: "tenant-a",
        purchaseOrderId: s.sent.id,
        kind: "CONFIRM" as const,
        evidence: "이메일",
        repliedAt: REPLIED_AT,
      };

      recordSupplierReply(s.deps, { ...base, poLineId: s.poLineId, quantity: 6, idempotencyKey: "r-1" }); // book-1 6권 전부
      // book-2는 자신의 5권을 전부 확정할 수 있다 (book-1의 소진과 무관)
      expect(() =>
        recordSupplierReply(s.deps, { ...base, poLineId: s.secondPoLineId!, quantity: 5, idempotencyKey: "r-2" }),
      ).not.toThrow();
      // book-2는 5권을 이미 다 썼으므로 1권 더는 불가
      expect(() =>
        recordSupplierReply(s.deps, { ...base, poLineId: s.secondPoLineId!, quantity: 1, idempotencyKey: "r-3" }),
      ).toThrow(/BUSINESS_INVARIANT/);
    });
  });

  describe("수락된 취소와의 대칭: 품절 확정과 수락된 취소의 합은 발주 수량을 넘을 수 없다 (BR-P01)", () => {
    /** 발주 10권에서 공급처가 취소 4권을 수락한 상태 */
    function withAcceptedCancel(options: { secondBook?: boolean } = {}) {
      const s = sentScene({ quantities: [4, 6], ...options });
      const asked = createCancellationRequest(s.deps, {
        tenantId: "tenant-a",
        purchaseOrderId: s.sent.id,
        poLineId: s.poLineId,
        quantity: 4,
        reason: "고객 취소",
        idempotencyKey: "cancel-1",
      });
      respondToCancellationRequest(s.deps, {
        tenantId: "tenant-a",
        purchaseOrderId: s.sent.id,
        cancellationRequestId: asked.id,
        acceptedQuantity: 4,
        rejectedQuantity: 0,
        evidence: "공급처 수락 회신",
        repliedAt: REPLIED_AT,
        idempotencyKey: "respond-1",
      });
      const reply = (extra: Record<string, unknown>, target = s.poLineId) =>
        recordSupplierReply(s.deps, {
          tenantId: "tenant-a",
          purchaseOrderId: s.sent.id,
          poLineId: target,
          kind: "OUT_OF_STOCK",
          quantity: 1,
          evidence: "공급처 이메일",
          repliedAt: REPLIED_AT,
          idempotencyKey: `r-${Math.random()}`,
          ...extra,
        } as never);
      return { ...s, reply };
    }

    it("수락된 취소 4권 후 품절 7권은 4 + 7 > 10이라 422이고, 저장하지 않으며 발주는 ACKNOWLEDGED가 되지 않는다", () => {
      const { sent, deps, reply } = withAcceptedCancel();

      const error = thrown(() => reply({ quantity: 7 }));

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(0);
      expect(deps.purchaseOrders.get("tenant-a", sent.id)!.status).toBe("SENT");
    });

    it("합이 정확히 발주 수량이면 허용한다 (수락 4 + 품절 6 = 10, 유효 발주 0권)", () => {
      const { deps, reply } = withAcceptedCancel();

      expect(() => reply({ quantity: 6 })).not.toThrow();
      expect(deps.replies.list("tenant-a", deps.purchaseOrders.list("tenant-a")[0]!.id)).toHaveLength(1);
    });

    it("수락된 취소는 확정·지연 풀을 바꾸지 않는다: 확정·지연 회신은 영향받지 않는다", () => {
      const { reply } = withAcceptedCancel();

      expect(() => reply({ kind: "CONFIRM", quantity: 6, idempotencyKey: "c1" })).not.toThrow();
      expect(() => reply({ kind: "DELAY", quantity: 4, eta: "2026-03-20", idempotencyKey: "d1" })).not.toThrow();
    });

    it("다른 품목의 수락된 취소는 이 품목의 품절 확정 가능 수량을 줄이지 않는다", () => {
      const { secondPoLineId, reply } = withAcceptedCancel({ secondBook: true }); // 품목1: 취소 4 수락, 품목2: 5권

      expect(() => reply({ quantity: 5 }, secondPoLineId!)).not.toThrow(); // 품목2 품절 5 (4 + 5 = 9가 아니다)
    });
  });

  it("이후 회신은 ACKNOWLEDGED 상태와 발주 버전을 더 바꾸지 않고 이벤트로 쌓인다", () => {
    const { sent, deps, request, state } = scene();
    recordSupplierReply(deps, request());
    const afterFirst = deps.purchaseOrders.get("tenant-a", sent.id)!;

    recordSupplierReply(deps, request({ kind: "OUT_OF_STOCK", quantity: 2, idempotencyKey: "reply-2" }));

    const po = deps.purchaseOrders.get("tenant-a", sent.id)!;
    expect(po).toEqual(afterFirst); // 상태·버전 그대로
    expect(deps.replies.list("tenant-a", sent.id)).toHaveLength(2);
    expect(state()).toMatchObject({ confirmed: 4, outOfStock: 2, unanswered: 0, qreduce: 2, qvalid: 4 });
  });
});
