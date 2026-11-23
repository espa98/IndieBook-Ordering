import { describe, it, expect } from "vitest";
import { recordSupplierReply } from "../../src/procurement/recordSupplierReply";
import { createCancellationRequest } from "../../src/procurement/createCancellationRequest";
import { respondToCancellationRequest } from "../../src/procurement/respondToCancellationRequest";
import { receiveGoods } from "../../src/inventory/receiveGoods";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { receivingScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("receiveGoods: 검수 입고 (ST-R01, DEC-03: 입고와 고객 배분은 별도 명령)", () => {
  it("정상 검수량은 별도 입고 기록으로 남고 전량 미배분이다. 발주 본문은 그대로다", () => {
    const { sent, deps, request, receipts } = receivingScene();
    const before = structuredClone(sent);

    const receipt = receiveGoods(deps, request());

    expect(receipt).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      purchaseOrderId: sent.id,
      poLineId: sent.lines[0]!.poLineId,
      normalQuantity: 4,
      excessQuantity: 0,
      damagedQuantity: 0,
      misdeliveredQuantity: 0,
      inspectedBy: "김검수",
      receivedAt: "2026-03-04T06:30:00.000Z", // 업무 발생 시각
      recordedAt: "2026-03-04T07:00:00.000Z", // 서버 기록 시각
    });
    expect(receipts.list("tenant-a", sent.id)).toEqual([receipt]);
    expect(deps.purchaseOrders.get("tenant-a", sent.id)).toEqual(before); // 발주는 그대로 (입고가 확인 회신을 대신하지 않는다)
  });

  describe("발주 상태 (BR-P03)", () => {
    it("확인 회신이 없는 SENT 발주에도, ACKNOWLEDGED 발주에도 검수 입고를 등록할 수 있다", () => {
      for (const status of ["SENT", "ACKNOWLEDGED"] as const) {
        const { sent, deps, request } = receivingScene();
        deps.purchaseOrders.save({ ...sent, status });

        const receipt = receiveGoods(deps, request());

        expect(receipt.normalQuantity).toBe(4);
      }
    });

    it.each(["DRAFT", "READY", "CANCELLED"] as const)(
      "%s 발주(실제 전달되지 않았거나 취소됨)의 입고는 BUSINESS_INVARIANT로 막고 아무것도 저장하지 않는다",
      (status) => {
        const { sent, deps, request, receipts } = receivingScene();
        deps.purchaseOrders.save({ ...sent, status });

        const error = thrown(() => receiveGoods(deps, request()));

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
        expect(receipts.list("tenant-a", sent.id)).toEqual([]);
      },
    );
  });

  describe("대상 확인: 없는 것과 남의 것은 구별할 수 없다", () => {
    it.each([
      ["없는 발주", { purchaseOrderId: "missing" }],
      ["다른 테넌트의 요청", { tenantId: "tenant-b" }],
      ["발주에 없는 품목", { poLineId: "missing" }],
    ])("%s는 NOT_FOUND이고 저장하지 않는다", (_name, extra) => {
      const { sent, deps, request, receipts } = receivingScene();

      const error = thrown(() => receiveGoods(deps, request(extra)));

      expect((error as AppError).code).toBe("NOT_FOUND");
      expect(receipts.list("tenant-a", sent.id)).toEqual([]);
      expect(receipts.list("tenant-b", sent.id)).toEqual([]);
    });
  });

  describe("입력 검증: 잘못된 입력은 VALIDATION_ERROR이고 아무것도 저장하지 않는다", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["정상량 음수", { normalQuantity: -1 }],
      ["정상량 소수", { normalQuantity: 1.5 }],
      ["정상량 문자열", { normalQuantity: "4" }],
      ["파손량 음수", { damagedQuantity: -1 }],
      ["파손량 소수", { damagedQuantity: 0.5 }],
      ["오배송량 음수", { misdeliveredQuantity: -1 }],
      ["오배송량 소수", { misdeliveredQuantity: 0.5 }],
      ["모든 수량이 0", { normalQuantity: 0, damagedQuantity: 0, misdeliveredQuantity: 0 }],
      ["검수자 빈 문자열", { inspectedBy: "  " }],
      ["검수자 누락", { inspectedBy: undefined }],
      ["입고 시각이 날짜만", { receivedAt: "2026-03-04" }],
      ["입고 시각이 미래", { receivedAt: "2026-03-04T07:00:01.000Z" }],
      ["발주 ID 빈 문자열", { purchaseOrderId: "" }],
      ["품목 ID 빈 문자열", { poLineId: "" }],
    ];

    it.each(bad)("%s", (_name, extra) => {
      const { sent, deps, request, receipts } = receivingScene();

      const error = thrown(() => receiveGoods(deps, request(extra)));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect(receipts.list("tenant-a", sent.id)).toEqual([]);
    });

    it("파손·오배송만 있는 검수(정상량 0)는 허용된다: 정상 입고로 세지 않는다", () => {
      const { deps, request } = receivingScene();

      const receipt = receiveGoods(
        deps,
        request({ normalQuantity: 0, damagedQuantity: 2 }),
      );

      expect(receipt).toMatchObject({ normalQuantity: 0, damagedQuantity: 2 });
    });
  });

  describe("초과입고는 승인 전까지 정상 입고와 분리한다 (D30, BR-P03, 사용자 결정: 승인 전 격리)", () => {
    it("한 번에 유효 발주량(6권)을 넘으면 넘은 만큼만 excessQuantity로 분리하고 정상량은 상한까지만 잡는다", () => {
      const { deps, request } = receivingScene();

      const receipt = receiveGoods(deps, request({ normalQuantity: 8 }));

      expect(receipt).toMatchObject({ normalQuantity: 6, excessQuantity: 2 });
    });

    it("이전 입고의 누적을 반영한다: 4권 입고 뒤 3권을 받으면 정상 2권, 초과 1권이다", () => {
      const { deps, request } = receivingScene();
      receiveGoods(deps, request({ normalQuantity: 4 }));

      const second = receiveGoods(
        deps,
        request({ normalQuantity: 3, idempotencyKey: "recv-2" }),
      );

      expect(second).toMatchObject({ normalQuantity: 2, excessQuantity: 1 });
    });

    it("이미 유효량을 모두 받은 뒤에는 정상 0권, 전량이 초과다", () => {
      const { deps, request } = receivingScene();
      receiveGoods(deps, request({ normalQuantity: 6 }));

      const second = receiveGoods(
        deps,
        request({ normalQuantity: 2, idempotencyKey: "recv-2" }),
      );

      expect(second).toMatchObject({ normalQuantity: 0, excessQuantity: 2 });
    });
  });

  describe("유효 발주량은 공급처가 확정한 축소를 반영한다 (BR-P01, BR-Q12, DEC-04)", () => {
    it("품절 확정 2권이면 유효량 4권: 5권을 받으면 정상 4권, 초과 1권이다", () => {
      const { deps, request, sent, poLineId } = receivingScene();
      recordSupplierReply(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        poLineId,
        kind: "OUT_OF_STOCK",
        quantity: 2,
        evidence: "공급처 품절 통보",
        repliedAt: "2026-03-04T05:30:00.000Z",
        idempotencyKey: "reply-oos",
      });

      const receipt = receiveGoods(deps, request({ normalQuantity: 5 }));

      expect(receipt).toMatchObject({ normalQuantity: 4, excessQuantity: 1 });
    });

    function cancelRequest(scene: ReturnType<typeof receivingScene>) {
      const { deps, sent, poLineId } = scene;
      return createCancellationRequest(deps, {
        tenantId: "tenant-a",
        purchaseOrderId: sent.id,
        poLineId,
        quantity: 2,
        reason: "고객 취소",
        idempotencyKey: "cancel-1",
      });
    }

    it("요청만 하고 수락되지 않은 취소는 유효량을 줄이지 않는다", () => {
      const scene = receivingScene();
      cancelRequest(scene);

      const receipt = receiveGoods(scene.deps, scene.request({ normalQuantity: 6 }));

      expect(receipt).toMatchObject({ normalQuantity: 6, excessQuantity: 0 });
    });

    it("공급처가 수락한 취소 2권은 유효량을 줄인다: 5권을 받으면 정상 4권, 초과 1권이다", () => {
      const scene = receivingScene();
      const cancel = cancelRequest(scene);
      respondToCancellationRequest(scene.deps, {
        tenantId: "tenant-a",
        purchaseOrderId: scene.sent.id,
        cancellationRequestId: cancel.id,
        acceptedQuantity: 2,
        rejectedQuantity: 0,
        evidence: "공급처 취소 수락 메일",
        repliedAt: "2026-03-04T05:40:00.000Z",
        idempotencyKey: "cancel-resp-1",
      });

      const receipt = receiveGoods(scene.deps, scene.request({ normalQuantity: 5 }));

      expect(receipt).toMatchObject({ normalQuantity: 4, excessQuantity: 1 });
    });
  });

  describe("파손·오배송은 정상 입고와 별도로 귀속한다 (ST-R01, BR-P04)", () => {
    it("파손·오배송 수량은 정상 입고 누적에 들어가지 않는다: 파손 3권 뒤에도 유효량 6권을 정상으로 받을 수 있다", () => {
      const { deps, request } = receivingScene();
      const damaged = receiveGoods(
        deps,
        request({ normalQuantity: 0, damagedQuantity: 3, misdeliveredQuantity: 2 }),
      );
      expect(damaged).toMatchObject({
        normalQuantity: 0,
        excessQuantity: 0,
        damagedQuantity: 3,
        misdeliveredQuantity: 2,
      });

      const normal = receiveGoods(
        deps,
        request({ normalQuantity: 6, idempotencyKey: "recv-2" }),
      );

      expect(normal).toMatchObject({ normalQuantity: 6, excessQuantity: 0 });
    });
  });

  describe("멱등키: 같은 입고를 두 번 쌓으면 곧 재고 이중 계상이다", () => {
    it("같은 키·같은 본문의 재시도는 같은 입고를 반환하고 이중으로 쌓이지 않는다", () => {
      const { sent, deps, request, receipts } = receivingScene();

      const first = receiveGoods(deps, request());
      const retry = receiveGoods(deps, request());

      expect(retry).toEqual(first);
      expect(receipts.list("tenant-a", sent.id)).toHaveLength(1);
    });

    it("같은 키에 본문이 다르면 IDEMPOTENCY_CONFLICT이고 두 번째는 저장하지 않는다", () => {
      const { sent, deps, request, receipts } = receivingScene();
      receiveGoods(deps, request());

      const error = thrown(() => receiveGoods(deps, request({ normalQuantity: 5 })));

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect(receipts.list("tenant-a", sent.id)).toHaveLength(1);
    });

    it("빈 키는 VALIDATION_ERROR다", () => {
      const { deps, request } = receivingScene();

      const error = thrown(() => receiveGoods(deps, request({ idempotencyKey: " " })));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    });
  });
});
