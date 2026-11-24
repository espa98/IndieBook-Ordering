import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { cancelUndeliveredPurchaseOrder } from "../../src/procurement/cancelUndeliveredPurchaseOrder";
import { releaseSourcing } from "../../src/procurement/releaseSourcing";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { markPurchaseOrderReady } from "../../src/procurement/markPurchaseOrderReady";
import { sentScene, world } from "../helpers/procurementWorld";

/** 주문 2권의 배정 1개로 만든 DRAFT 발주가 있는 세계 */
function draftScene() {
  const w = world();
  const order = w.addOrder([{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }]);
  const allocation = w.allocate(order, 0, 2);
  const draft = createPurchaseOrder(w.deps, w.request([allocation.id]));
  const deps = { ...w.deps, now: () => new Date("2026-03-04T07:00:00.000Z") };
  let seq = 0;
  const cancelRequest = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: draft.id,
    expectedVersion: draft.version,
    reason: "공급처를 잘못 선택해 발주 재작성",
    cancelledBy: "김직원",
    cancelledAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `cpo-${++seq}`,
    ...extra,
  });
  return { w, order, allocation, draft, deps, cancelRequest };
}

describe("cancelUndeliveredPurchaseOrder: 미전달 발주 취소 (ST-P09)", () => {
  it("DRAFT 발주를 취소하면 CANCELLED(version+1)와 사유·담당자가 기록되고, 연결됐던 배정은 ACTIVE로 남아 새 발주에 다시 연결할 수 있다", () => {
    const { w, allocation, draft, deps, cancelRequest } = draftScene();

    const cancelled = cancelUndeliveredPurchaseOrder(deps, cancelRequest());

    expect(cancelled).toMatchObject({
      id: draft.id,
      status: "CANCELLED",
      version: draft.version + 1,
      cancelledAt: "2026-03-04T06:50:00.000Z",
      cancelledBy: "김직원",
      cancelReason: "공급처를 잘못 선택해 발주 재작성",
    });
    expect(deps.purchaseOrders.get("tenant-a", draft.id)).toEqual(cancelled);
    expect(deps.allocations.get("tenant-a", allocation.id)!.status).toBe("ACTIVE");
    expect(() => createPurchaseOrder(w.deps, w.request([allocation.id]))).not.toThrow();
  });

  it("READY 발주도 취소할 수 있고, 취소 뒤에는 연결됐던 배정을 해제할 수 있다 (ST-P02 연계)", () => {
    const { allocation, draft, deps, cancelRequest } = draftScene();
    const ready = markPurchaseOrderReady(deps, {
      tenantId: "tenant-a",
      purchaseOrderId: draft.id,
      expectedVersion: draft.version,
      idempotencyKey: "ready-x",
    });

    const cancelled = cancelUndeliveredPurchaseOrder(
      deps,
      cancelRequest({ expectedVersion: ready.version }),
    );

    expect(cancelled.status).toBe("CANCELLED");
    expect(
      releaseSourcing(
        { ...deps, sourcingReleases: { list: () => [], save: () => undefined } },
        {
          tenantId: "tenant-a",
          allocationId: allocation.id,
          reason: "고객 취소",
          releasedBy: "김직원",
          releasedAt: "2026-03-04T06:55:00.000Z",
          idempotencyKey: "rel-after-cancel",
        },
      ).retainedObligations,
    ).toEqual([]);
  });

  it("전달된 발주(SENT)·이미 취소된 발주는 취소할 수 없고(BUSINESS_INVARIANT 422), version이 다르면 VERSION_CONFLICT 409, 형식 오류는 VALIDATION_ERROR 400이며 발주는 변하지 않는다", () => {
    const { draft, deps, cancelRequest } = draftScene();
    const before = structuredClone(deps.purchaseOrders.get("tenant-a", draft.id));
    const codeOf = (target: typeof deps, extra: Record<string, unknown>) => {
      try {
        cancelUndeliveredPurchaseOrder(target, cancelRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(deps, { expectedVersion: draft.version + 1 })).toBe("VERSION_CONFLICT");
    expect(codeOf(deps, { reason: "" })).toBe("VALIDATION_ERROR");
    expect(codeOf(deps, { cancelledBy: " " })).toBe("VALIDATION_ERROR");
    expect(codeOf(deps, { cancelledAt: "2999-01-01T00:00:00.000Z" })).toBe("VALIDATION_ERROR");
    expect(codeOf(deps, { purchaseOrderId: "no-such" })).toBe("NOT_FOUND");
    expect(codeOf(deps, { tenantId: "tenant-b" })).toBe("NOT_FOUND");
    expect(deps.purchaseOrders.get("tenant-a", draft.id)).toEqual(before);

    expect(codeOf(deps, {})).toBeUndefined();
    expect(codeOf(deps, { expectedVersion: draft.version + 1 })).toBe("BUSINESS_INVARIANT"); // 이미 취소됨

    const scene = sentScene();
    const sentDeps = { ...scene.w.deps, now: () => new Date("2026-03-04T07:00:00.000Z") };
    const sentBefore = structuredClone(sentDeps.purchaseOrders.get("tenant-a", scene.sent.id));
    expect(
      codeOf(sentDeps as never, { purchaseOrderId: scene.sent.id, expectedVersion: scene.sent.version }),
    ).toBe("BUSINESS_INVARIANT");
    expect(sentDeps.purchaseOrders.get("tenant-a", scene.sent.id)).toEqual(sentBefore);
  });
});
