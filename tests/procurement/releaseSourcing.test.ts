import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { releaseSourcing } from "../../src/procurement/releaseSourcing";
import type { SourcingRelease } from "../../src/procurement/releaseSourcing";
import { sentScene, world } from "../helpers/procurementWorld";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 발주에 연결되지 않은 조달 배정(주문 2권 중 2권)이 있는 세계 */
function releaseScene() {
  const w = world();
  const order = w.addOrder([{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }]);
  const allocation = w.allocate(order, 0, 2);
  const saved: SourcingRelease[] = [];
  const deps = {
    ...w.deps,
    sourcingReleases: { list: () => saved, save: (r: SourcingRelease) => void saved.push(r) },
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const releaseRequest = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    allocationId: allocation.id,
    reason: "고객이 다른 서점에서 구매",
    releasedBy: "김직원",
    releasedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `rel-${++seq}`,
    ...extra,
  });
  return { w, order, allocation, deps, saved, releaseRequest };
}

describe("releaseSourcing: 미이행 조달 배정 해제 (ST-P02)", () => {
  it("발주에 연결되지 않은 ACTIVE 배정을 해제하면 RELEASED가 되고 해제 기록이 남으며 같은 수량을 다시 배정할 수 있다", () => {
    const { w, order, allocation, deps, saved, releaseRequest } = releaseScene();

    const release = releaseSourcing(deps, releaseRequest());

    expect(release).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      allocationId: allocation.id,
      orderId: order.id,
      lineId: order.lines[0]!.lineId,
      supplierCode: "sup-a",
      quantity: 2,
      reason: "고객이 다른 서점에서 구매",
      retainedObligations: [],
      releasedBy: "김직원",
      releasedAt: "2026-03-04T06:50:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(saved).toEqual([release]);
    expect(deps.allocations.get("tenant-a", allocation.id)).toMatchObject({ status: "RELEASED", quantity: 2 });
    expect(() => w.allocate(order, 0, 2)).not.toThrow();
  });

  it("이미 해제된 배정·형식 오류는 거부하고, 없는 배정과 타 테넌트 배정은 NOT_FOUND이며 아무것도 기록되지 않는다", () => {
    const { allocation, deps, saved, releaseRequest } = releaseScene();
    const codeOf = (extra: Record<string, unknown>) => {
      try {
        releaseSourcing(deps, releaseRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ reason: "" })).toBe("VALIDATION_ERROR");
    expect(codeOf({ releasedBy: " " })).toBe("VALIDATION_ERROR");
    expect(codeOf({ releasedAt: "2999-01-01T00:00:00.000Z" })).toBe("VALIDATION_ERROR");
    expect(codeOf({ allocationId: "no-such" })).toBe("NOT_FOUND");
    expect(codeOf({ tenantId: "tenant-b" })).toBe("NOT_FOUND");
    expect(saved).toEqual([]);
    expect(deps.allocations.get("tenant-a", allocation.id)!.status).toBe("ACTIVE");

    expect(codeOf({})).toBeUndefined();
    expect(codeOf({})).toBe("BUSINESS_INVARIANT"); // 이미 RELEASED
    expect(saved).toHaveLength(1);
  });

  it("아직 전달되지 않은 발주(DRAFT·READY)에 연결된 배정은 해제할 수 없고 발주를 먼저 취소해야 한다 (BUSINESS_INVARIANT 422)", () => {
    const { w, allocation, deps, saved, releaseRequest } = releaseScene();
    createPurchaseOrder(w.deps, w.request([allocation.id]));

    let thrown: unknown;
    try {
      releaseSourcing(deps, releaseRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(saved).toEqual([]);
    expect(deps.allocations.get("tenant-a", allocation.id)!.status).toBe("ACTIVE");
  });

  it("이미 전달된 발주(SENT)에 연결된 배정은 해제할 수 있고, 발주는 그대로 두며 남는 외부 의무를 해제 기록에 남긴다", () => {
    const scene = sentScene();
    const allocation = scene.allocations[0]!; // 주문 2권분이 발주 6권에 합산됨
    const saved: SourcingRelease[] = [];
    const deps = {
      allocations: scene.w.deps.allocations,
      purchaseOrders: scene.w.deps.purchaseOrders,
      idempotency: scene.w.deps.idempotency,
      sourcingReleases: { list: () => saved, save: (r: SourcingRelease) => void saved.push(r) },
      now: () => new Date("2026-03-04T07:00:00.000Z"),
    };
    const poBefore = structuredClone(scene.w.deps.purchaseOrders.get("tenant-a", scene.sent.id));

    const release = releaseSourcing(deps, {
      tenantId: "tenant-a",
      allocationId: allocation.id,
      reason: "고객 취소",
      releasedBy: "김직원",
      releasedAt: "2026-03-04T06:50:00.000Z",
      idempotencyKey: "rel-sent",
    });

    expect(release.retainedObligations).toEqual([
      { purchaseOrderId: scene.sent.id, poLineId: scene.poLineId, quantity: 2 },
    ]);
    expect(deps.allocations.get("tenant-a", allocation.id)!.status).toBe("RELEASED");
    expect(scene.w.deps.purchaseOrders.get("tenant-a", scene.sent.id)).toEqual(poBefore);
  });
});
