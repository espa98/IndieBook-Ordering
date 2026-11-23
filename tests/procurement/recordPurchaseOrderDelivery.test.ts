import { describe, it, expect } from "vitest";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { exportPurchaseOrderCsv } from "../../src/procurement/exportPurchaseOrderCsv";
import { markPurchaseOrderReady } from "../../src/procurement/markPurchaseOrderReady";
import { recordPurchaseOrderDelivery } from "../../src/procurement/recordPurchaseOrderDelivery";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { createInMemoryExportRepository } from "../helpers/procurementFixtures";
import { world } from "../helpers/procurementWorld";

const NOW = "2026-03-04T06:00:00.000Z";
const DELIVERED_AT = "2026-03-04T05:06:07.000Z"; // 기록 시각보다 이전: 실제 전달은 먼저 일어났다

/** READY 발주 1개(version 2)가 있는 세계 */
function readyScene() {
  const w = world();
  const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
  const allocation = w.allocate(order, 0, 2);
  const draft = createPurchaseOrder(w.deps, w.request([allocation.id]));
  const ready = markPurchaseOrderReady(w.deps, {
    tenantId: "tenant-a",
    purchaseOrderId: draft.id,
    expectedVersion: 1,
    idempotencyKey: "ready-1",
  });
  const exports = createInMemoryExportRepository();
  const deps = {
    purchaseOrders: w.deps.purchaseOrders,
    exports,
    idempotency: w.deps.idempotency,
    now: () => new Date(NOW),
  };
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: ready.id,
    expectedVersion: 2,
    method: "EMAIL" as const,
    deliveredAt: DELIVERED_AT,
    deliveredBy: "홍길동",
    referenceNumber: "MSG-123",
    idempotencyKey: "send-1",
    ...extra,
  });
  return { w, ready, deps, request, exports };
}

describe("recordPurchaseOrderDelivery (ST-P06: READY → SENT, 실제 전달 기록)", () => {
  it("READY를 SENT로 바꾸고 전달 사실(담당자·방식·시각·참조번호·전달 버전)을 기록하며, 접수 확인(ACKNOWLEDGED)은 하지 않는다", () => {
    const { w, ready, deps, request } = readyScene();
    const before = structuredClone(ready);

    const sent = recordPurchaseOrderDelivery(deps, request());

    expect(sent.status).toBe("SENT"); // ACKNOWLEDGED가 아니다: 확인 근거가 없다 (PO-005)
    expect(sent.version).toBe(3);
    expect(sent.lines).toEqual(ready.lines); // 품목·연결은 그대로
    expect(sent.delivery).toEqual({
      method: "EMAIL",
      deliveredAt: DELIVERED_AT, // 업무 발생 시각: 사용자가 알려 준 실제 전달 시각
      recordedAt: NOW, // 서버 기록 시각: 둘은 구분된다
      deliveredBy: "홍길동",
      referenceNumber: "MSG-123",
      poVersion: 2, // 전달한 발주 버전
    });
    expect(w.deps.purchaseOrders.get("tenant-a", ready.id)).toEqual(sent);
    expect(ready).toEqual(before); // 원본 불변
  });

  describe("사전조건: READY이고 expectedVersion이 맞아야 한다", () => {
    it.each([
      ["DRAFT 발주(아직 버전 미확정)", "DRAFT"],
      ["이미 SENT인 발주(다른 키로 재전달 기록 → 중복 발주 방지)", "SENT"],
      ["CANCELLED 발주", "CANCELLED"],
    ] as const)("%s → BUSINESS_INVARIANT(422)이고 발주는 바뀌지 않는다", (_name, status) => {
      const { w, ready, deps, request } = readyScene();
      const stored = { ...ready, status };
      w.deps.purchaseOrders.save(stored);

      const error = thrown(() => recordPurchaseOrderDelivery(deps, request()));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(w.deps.purchaseOrders.get("tenant-a", ready.id)).toEqual(stored);
    });

    it.each([
      ["expectedVersion 불일치", { expectedVersion: 99 }, "VERSION_CONFLICT", 409],
      ["expectedVersion 0", { expectedVersion: 0 }, "VALIDATION_ERROR", 400],
      ["expectedVersion 문자열", { expectedVersion: "2" }, "VALIDATION_ERROR", 400],
      ["expectedVersion null", { expectedVersion: null }, "VALIDATION_ERROR", 400],
      ["purchaseOrderId 빈 문자열", { purchaseOrderId: "" }, "VALIDATION_ERROR", 400],
      ["없는 발주", { purchaseOrderId: "00000000-0000-4000-8000-000000000000" }, "NOT_FOUND", 404],
    ] as const)("%s → 올바른 오류 코드·HTTP 상태로 거절되고 발주는 READY 그대로다", (_name, bad, code, status) => {
      const { w, ready, deps, request } = readyScene();

      const error = thrown(() => recordPurchaseOrderDelivery(deps, request(bad) as never));

      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
      expect(w.deps.purchaseOrders.get("tenant-a", ready.id)).toEqual(ready);
    });

    it("타 테넌트의 발주는 없는 발주와 구별할 수 없는 동일한 NOT_FOUND이다", () => {
      const { w, ready, deps, request } = readyScene();
      const missing = thrown(() =>
        recordPurchaseOrderDelivery(deps, request({ purchaseOrderId: "00000000-0000-4000-8000-000000000000" })),
      );

      const crossTenant = thrown(() => recordPurchaseOrderDelivery(deps, request({ tenantId: "tenant-b" })));

      expect((crossTenant as AppError).code).toBe("NOT_FOUND");
      expect((crossTenant as AppError).message).toBe((missing as AppError).message);
      expect(w.deps.purchaseOrders.get("tenant-a", ready.id)).toEqual(ready);
    });
  });

  describe("전달 기록 필드 검증 (감사 근거이므로 엄격하다)", () => {
    it.each([
      ["method 허용되지 않은 값", { method: "FAX" }, /method/],
      ["method 대소문자 다름", { method: "email" }, /method/],
      ["method 빈 문자열", { method: "" }, /method/],
      ["method 누락", { method: undefined }, /method/],
      ["method 숫자", { method: 7 }, /method/],
      ["deliveredAt 누락", { deliveredAt: undefined }, /deliveredAt/],
      ["deliveredAt 빈 문자열", { deliveredAt: "" }, /deliveredAt/],
      ["deliveredAt 날짜만", { deliveredAt: "2026-03-04" }, /deliveredAt/],
      ["deliveredAt UTC 아님(+09:00)", { deliveredAt: "2026-03-04T05:06:07+09:00" }, /deliveredAt/],
      ["deliveredAt 날짜가 아님", { deliveredAt: "not a date" }, /deliveredAt/],
      ["deliveredAt 존재하지 않는 날짜", { deliveredAt: "2026-13-45T00:00:00Z" }, /deliveredAt/],
      ["deliveredAt 미래(기록 시각보다 1초 뒤)", { deliveredAt: "2026-03-04T06:00:01.000Z" }, /deliveredAt/],
      ["deliveredBy 빈 문자열", { deliveredBy: "" }, /deliveredBy/],
      ["deliveredBy 공백", { deliveredBy: "   " }, /deliveredBy/],
      ["deliveredBy 누락", { deliveredBy: undefined }, /deliveredBy/],
      ["deliveredBy 숫자", { deliveredBy: 7 }, /deliveredBy/],
      ["referenceNumber 빈 문자열", { referenceNumber: "" }, /referenceNumber/],
      ["referenceNumber 숫자", { referenceNumber: 7 }, /referenceNumber/],
      ["referenceNumber null", { referenceNumber: null }, /referenceNumber/],
      ["fileVersion 0", { fileVersion: 0 }, /fileVersion/],
      ["fileVersion 소수", { fileVersion: 1.5 }, /fileVersion/],
      ["fileVersion 문자열", { fileVersion: "1" }, /fileVersion/],
      ["fileVersion null", { fileVersion: null }, /fileVersion/],
    ])("%s → 400 VALIDATION_ERROR이고 발주는 READY 그대로다", (_name, bad, field) => {
      const { w, ready, deps, request } = readyScene();

      const error = thrown(() => recordPurchaseOrderDelivery(deps, request(bad) as never));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(field);
      expect(w.deps.purchaseOrders.get("tenant-a", ready.id)).toEqual(ready);
    });

    it("6개 방식이 모두 허용된다", () => {
      for (const method of ["WEB", "EMAIL", "PHONE", "MESSENGER", "FILE", "API"] as const) {
        const { deps, request } = readyScene();
        expect(recordPurchaseOrderDelivery(deps, request({ method })).delivery!.method).toBe(method);
      }
    });

    it("deliveredAt이 기록 시각과 같으면 허용하고, 밀리초가 없으면 정규화한다", () => {
      const { deps, request } = readyScene();

      const sent = recordPurchaseOrderDelivery(deps, request({ deliveredAt: "2026-03-04T06:00:00Z" }));

      expect(sent.delivery!.deliveredAt).toBe("2026-03-04T06:00:00.000Z");
    });

    it("fileVersion이 이 발주의 출력 이력에 있으면 전달 기록에 담기고, 없으면 BUSINESS_INVARIANT(422)이다", () => {
      const { w, ready, deps, request, exports } = readyScene();
      const missing = thrown(() => recordPurchaseOrderDelivery(deps, request({ fileVersion: 1 })));
      expect((missing as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((missing as AppError).httpStatus).toBe(422);
      expect(w.deps.purchaseOrders.get("tenant-a", ready.id)).toEqual(ready);

      exportPurchaseOrderCsv({ purchaseOrders: w.deps.purchaseOrders, exports }, { tenantId: "tenant-a", purchaseOrderId: ready.id });
      const sent = recordPurchaseOrderDelivery(deps, request({ fileVersion: 1 }));

      expect(sent.delivery!.fileVersion).toBe(1);
    });
  });

  describe("멱등키", () => {
    it("같은 키·같은 본문의 재시도는 이미 SENT가 되었어도 같은 결과를 반환한다 (한 번만 전달 처리)", () => {
      const { w, deps, request } = readyScene();

      const first = recordPurchaseOrderDelivery(deps, request());
      const retry = recordPurchaseOrderDelivery(deps, request()); // 멱등이 아니면 SENT라서 422

      expect(retry).toEqual(first);
      expect(retry.version).toBe(3); // 한 번만 올랐다
      expect(w.deps.purchaseOrders.get("tenant-a", first.id)).toEqual(first);
    });

    it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이고 기록을 바꾸지 않는다", () => {
      const { w, deps, request } = readyScene();
      const first = recordPurchaseOrderDelivery(deps, request());

      const error = thrown(() =>
        recordPurchaseOrderDelivery(deps, request({ method: "PHONE", deliveredBy: "다른사람" })),
      );

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
      expect(w.deps.purchaseOrders.get("tenant-a", first.id)).toEqual(first);
    });

    it.each(["", "   ", undefined])("멱등키가 비어 있으면(%j) 400이고 발주는 READY 그대로다", (key) => {
      const { w, ready, deps, request } = readyScene();

      const error = thrown(() => recordPurchaseOrderDelivery(deps, request({ idempotencyKey: key }) as never));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/Idempotency-Key/);
      expect(w.deps.purchaseOrders.get("tenant-a", ready.id)).toEqual(ready);
    });
  });

  describe("SENT 이후의 연쇄 효과 (중복 발주 위험 차단)", () => {
    function sentScene() {
      const s = readyScene();
      const sent = recordPurchaseOrderDelivery(s.deps, s.request());
      return { ...s, sent };
    }

    it("SENT 발주는 파일 출력도, 다시 READY로 만들기도 할 수 없다", () => {
      const { w, sent, exports } = sentScene();

      const exportError = thrown(() =>
        exportPurchaseOrderCsv(
          { purchaseOrders: w.deps.purchaseOrders, exports },
          { tenantId: "tenant-a", purchaseOrderId: sent.id },
        ),
      );
      const readyError = thrown(() =>
        markPurchaseOrderReady(w.deps, {
          tenantId: "tenant-a",
          purchaseOrderId: sent.id,
          expectedVersion: sent.version,
          idempotencyKey: "ready-again",
        }),
      );

      expect((exportError as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((readyError as AppError).code).toBe("BUSINESS_INVARIANT");
      expect(exports.list("tenant-a", sent.id)).toHaveLength(0);
    });

    it("SENT 발주에 연결된 배정은 다른 발주에 다시 연결할 수 없다 (중복 재발주 방지)", () => {
      const { w, sent } = sentScene();
      const allocationId = sent.lines[0]!.links[0]!.allocationId;

      const error = thrown(() => createPurchaseOrder(w.deps, w.request([allocationId])));

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(1);
    });
  });

  it("참조번호는 선택이다 (전화 등 확인번호가 없는 방식)", () => {
    const { deps, request } = readyScene();

    const sent = recordPurchaseOrderDelivery(
      deps,
      request({ method: "PHONE", referenceNumber: undefined }),
    );

    expect(sent.status).toBe("SENT");
    expect(sent.delivery!.referenceNumber).toBeUndefined();
  });
});
