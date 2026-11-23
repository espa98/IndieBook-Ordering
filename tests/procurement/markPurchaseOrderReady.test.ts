import { describe, it, expect } from "vitest";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { markPurchaseOrderReady } from "../../src/procurement/markPurchaseOrderReady";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { world } from "../helpers/procurementWorld";

/** DRAFT 발주 1개가 있는 세계 */
function scene() {
  const w = world();
  const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
  const allocation = w.allocate(order, 0, 2);
  const draft = createPurchaseOrder(w.deps, w.request([allocation.id]));
  const ready = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: draft.id,
    expectedVersion: 1,
    idempotencyKey: "ready-1",
    ...extra,
  });
  return { w, draft, ready };
}

describe("markPurchaseOrderReady (ST-P04: DRAFT → READY)", () => {
  it("DRAFT를 READY로 바꾸고 version을 1 올려 저장하며, 원본은 바꾸지 않는다", () => {
    const { w, draft, ready } = scene();
    const before = structuredClone(draft);

    const result = markPurchaseOrderReady(w.deps, ready());

    expect(result.status).toBe("READY");
    expect(result.version).toBe(2);
    expect(result.id).toBe(draft.id);
    expect(result.lines).toEqual(draft.lines); // 품목·연결은 그대로
    expect(w.deps.purchaseOrders.get("tenant-a", draft.id)).toEqual(result);
    expect(draft).toEqual(before);
  });

  describe("거절", () => {
    it.each([
      ["expectedVersion 불일치", { expectedVersion: 99 }, "VERSION_CONFLICT", 409],
      ["expectedVersion 0", { expectedVersion: 0 }, "VALIDATION_ERROR", 400],
      ["expectedVersion 문자열", { expectedVersion: "1" }, "VALIDATION_ERROR", 400],
      ["expectedVersion null", { expectedVersion: null }, "VALIDATION_ERROR", 400],
      ["없는 발주", { purchaseOrderId: "00000000-0000-4000-8000-000000000000" }, "NOT_FOUND", 404],
      ["purchaseOrderId 빈 문자열", { purchaseOrderId: "" }, "VALIDATION_ERROR", 400],
      ["멱등키 빈 문자열", { idempotencyKey: "" }, "VALIDATION_ERROR", 400],
    ] as const)("%s → 올바른 오류 코드·HTTP 상태로 거절되고 발주는 DRAFT 그대로다", (_name, bad, code, status) => {
      const { w, draft, ready } = scene();

      const error = thrown(() => markPurchaseOrderReady(w.deps, ready(bad) as never));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
      expect(w.deps.purchaseOrders.get("tenant-a", draft.id)).toEqual(draft);
    });

    it("타 테넌트의 발주는 없는 발주와 구별할 수 없는 동일한 NOT_FOUND이다", () => {
      const { w, draft, ready } = scene();
      const missing = thrown(() =>
        markPurchaseOrderReady(w.deps, ready({ purchaseOrderId: "00000000-0000-4000-8000-000000000000" })),
      );
      // tenant-b가 tenant-a의 발주 ID로 접근
      const crossTenant = thrown(() => markPurchaseOrderReady(w.deps, ready({ tenantId: "tenant-b" })));

      expect((crossTenant as AppError).code).toBe("NOT_FOUND");
      expect((crossTenant as AppError).message).toBe((missing as AppError).message);
      expect(w.deps.purchaseOrders.get("tenant-a", draft.id)!.status).toBe("DRAFT");
    });

    it.each(["READY", "CANCELLED"] as const)("%s 발주는 다시 READY로 만들 수 없다 → BUSINESS_INVARIANT(422)", (status) => {
      const { w, draft, ready } = scene();
      w.deps.purchaseOrders.save({ ...draft, status, version: 2 });

      const error = thrown(() => markPurchaseOrderReady(w.deps, ready({ expectedVersion: 2 })));

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
    });
  });

  it("같은 키·같은 본문의 재시도는 이미 READY가 되었어도 같은 결과를 반환한다", () => {
    const { w, ready } = scene();

    const first = markPurchaseOrderReady(w.deps, ready());
    const retry = markPurchaseOrderReady(w.deps, ready()); // 멱등이 아니면 DRAFT가 아니라서 422

    expect(retry).toEqual(first);
    expect(retry.version).toBe(2); // 한 번만 올랐다
  });

  it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이다", () => {
    const { w, ready } = scene();
    markPurchaseOrderReady(w.deps, ready());

    const error = thrown(() => markPurchaseOrderReady(w.deps, ready({ expectedVersion: 2 })));

    expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((error as AppError).httpStatus).toBe(409);
  });
});
