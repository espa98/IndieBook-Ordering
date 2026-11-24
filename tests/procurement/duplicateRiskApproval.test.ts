import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { approveDuplicateRisk } from "../../src/procurement/approveDuplicateRisk";
import type { DuplicateRiskApproval } from "../../src/procurement/approveDuplicateRisk";
import { openSupplierObligations } from "../../src/procurement/supplierObligations";
import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { releaseSourcing } from "../../src/procurement/releaseSourcing";
import type { SourcingRelease } from "../../src/procurement/releaseSourcing";
import { receivingScene } from "../helpers/inventoryFixtures";

/** 6권 발주(주문 2/3/1권)가 sup-a에 SENT이고, 첫 주문(2권)의 배정이 해제되어 의무 2권이 남은 세계 */
function resourcingScene() {
  const s = receivingScene();
  const saved: SourcingRelease[] = [];
  const sourcingReleases = {
    list: (_t: string, allocationId: string) => saved.filter((r) => r.allocationId === allocationId),
    listByOrder: (t: string, orderId: string) => saved.filter((r) => r.tenantId === t && r.orderId === orderId),
    save: (r: SourcingRelease) => void saved.push(r),
  };
  const base = { ...s.deps, allocations: s.w.deps.allocations, suppliers: s.w.deps.suppliers, sourcingReleases };
  releaseSourcing(base, {
    tenantId: "tenant-a",
    allocationId: s.allocations[0]!.id,
    reason: "고객이 잠시 보류",
    releasedBy: "김직원",
    releasedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: "rel-rs",
  });
  const approvals: DuplicateRiskApproval[] = [];
  const duplicateRiskApprovals = {
    list: (t: string, orderId: string) => approvals.filter((a) => a.tenantId === t && a.orderId === orderId),
    save: (a: DuplicateRiskApproval) => void approvals.push(a),
  };
  const deps = {
    ...base,
    orders: s.w.deps.orders,
    duplicateRiskApprovals,
    supplierObligations: { ...base, duplicateRiskApprovals },
  };
  let seq = 0;
  const resourceRequest = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    orderId: s.orders[0]!.id,
    lineId: s.orders[0]!.lines[0]!.lineId,
    supplierCode: "sup-b",
    quantity: 2,
    idempotencyKey: `rs-${++seq}`,
    ...extra,
  });
  const approveRequest = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    orderId: s.orders[0]!.id,
    lineId: s.orders[0]!.lines[0]!.lineId,
    purchaseOrderId: s.sent.id,
    poLineId: s.poLineId,
    surplusPlan: "STOCK_INTAKE" as const,
    planNote: "두 공급처 모두 도착하면 남는 2권은 매장 재고로 편입",
    actorRole: "OWNER" as const,
    approvedBy: "점주",
    approvedAt: "2026-03-04T06:55:00.000Z",
    idempotencyKey: `dra-${++seq}`,
    ...extra,
  });
  return { ...s, deps, resourceRequest, approveRequest };
}

describe("재조달의 중복 위험 승인 (BR-P05)", () => {
  it("이전 공급처 의무가 남은 주문 품목을 다른 공급처로 다시 배정하려면 승인이 필요하다 (BUSINESS_INVARIANT 422)", () => {
    const { deps, resourceRequest } = resourcingScene();
    const before = deps.allocations.list("tenant-a").filter((a) => a.status === "ACTIVE").length;

    let thrown: unknown;
    try {
      allocateSourcing(deps, resourceRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).detail).toContain("duplicate-risk approval");
    expect(deps.allocations.list("tenant-a").filter((a) => a.status === "ACTIVE")).toHaveLength(before);
  });

  it("Owner가 잉여 처리 계획과 함께 승인하면 재배정할 수 있고, 이전 공급처의 의무는 그대로 보존된다", () => {
    const { deps, orders, sent, poLineId, resourceRequest, approveRequest } = resourcingScene();

    const approval = approveDuplicateRisk(deps, approveRequest());
    const allocation = allocateSourcing(deps, resourceRequest());

    expect(approval).toMatchObject({
      orderId: orders[0]!.id,
      purchaseOrderId: sent.id,
      poLineId,
      surplusPlan: "STOCK_INTAKE",
      approvedBy: "점주",
      approvedAt: "2026-03-04T06:55:00.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.duplicateRiskApprovals.list("tenant-a", orders[0]!.id)).toEqual([approval]);
    expect(allocation).toMatchObject({ supplierCode: "sup-b", status: "ACTIVE", quantity: 2 });
    expect(openSupplierObligations(deps.supplierObligations, "tenant-a", orders[0]!.id)).toHaveLength(1);
  });

  it("Staff는 승인할 수 없고(FORBIDDEN), 의무가 없는 대상·잘못된 계획·빈 메모는 거부하며 아무것도 기록되지 않는다", () => {
    const { deps, approveRequest } = resourcingScene();
    const codeOf = (extra: Record<string, unknown>) => {
      try {
        approveDuplicateRisk(deps, approveRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ actorRole: "STAFF" })).toBe("FORBIDDEN");
    expect(codeOf({ surplusPlan: "IGNORE" })).toBe("VALIDATION_ERROR");
    expect(codeOf({ planNote: " " })).toBe("VALIDATION_ERROR");
    expect(codeOf({ approvedBy: "" })).toBe("VALIDATION_ERROR");
    expect(codeOf({ poLineId: "no-such-line" })).toBe("BUSINESS_INVARIANT"); // 그 발주 품목에 열린 의무 없음
    expect(codeOf({ orderId: "no-such-order" })).toBe("BUSINESS_INVARIANT");
    expect(deps.duplicateRiskApprovals.list("tenant-a", approveRequest().orderId)).toEqual([]);
  });
});
