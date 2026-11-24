import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { receiveGoods } from "../../src/inventory/receiveGoods";
import { resolveReceiptDefect } from "../../src/inventory/resolveReceiptDefect";
import type {
  ReceiptDefectResolution,
  ResolveReceiptDefectRequest,
} from "../../src/inventory/resolveReceiptDefect";
import { receivingScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 6권 발주에 정상 4권·파손 2권·오배송 1권이 검수 등록된 세계 */
function defectScene() {
  const s = receivingScene();
  const receipt = receiveGoods(
    s.deps,
    s.request({ normalQuantity: 4, damagedQuantity: 2, misdeliveredQuantity: 1 }) as never,
  );
  const saved: ReceiptDefectResolution[] = [];
  const receiptDefectResolutions = {
    list: (t: string, receiptId: string) => saved.filter((r) => r.tenantId === t && r.receiptId === receiptId),
    save: (r: ReceiptDefectResolution) => void saved.push(r),
  };
  const deps = { ...s.deps, receiptDefectResolutions, now: () => new Date("2026-03-04T07:00:00.000Z") };
  let seq = 0;
  const resolveRequest = (extra: Partial<ResolveReceiptDefectRequest> = {}): ResolveReceiptDefectRequest => ({
    tenantId: "tenant-a",
    receiptId: receipt.id,
    kind: "DAMAGED",
    quantity: 2,
    outcome: "RETURNED_TO_SUPPLIER",
    evidence: "공급처 반품 접수 확인서",
    actorRole: "STAFF",
    resolvedBy: "김직원",
    resolvedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `rdr-${++seq}`,
    ...extra,
  });
  return { ...s, deps, receipt, saved, resolveRequest };
}

describe("resolveReceiptDefect: 파손·오배송 수량 처리 (BR-P06, ST-R01 예외 큐)", () => {
  it("검수에서 기록된 파손 수량을 공급처 반품으로 처리하면 추가 전용 처리 기록이 남고 입고 기록은 그대로다", () => {
    const { deps, receipt, saved, resolveRequest } = defectScene();

    const resolution = resolveReceiptDefect(deps, resolveRequest());

    expect(resolution).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      receiptId: receipt.id,
      purchaseOrderId: receipt.purchaseOrderId,
      kind: "DAMAGED",
      quantity: 2,
      outcome: "RETURNED_TO_SUPPLIER",
      evidence: "공급처 반품 접수 확인서",
      resolvedBy: "김직원",
      resolvedAt: "2026-03-04T06:50:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(saved).toEqual([resolution]);
    expect(deps.receipts.get("tenant-a", receipt.id)).toEqual(receipt);
  });

  it("형식 오류는 VALIDATION_ERROR 400, 폐기는 Owner만(FORBIDDEN 403), 없는 입고는 NOT_FOUND이며 아무것도 기록되지 않는다", () => {
    const { deps, saved, resolveRequest } = defectScene();
    const codeOf = (extra: Partial<ResolveReceiptDefectRequest>) => {
      try {
        resolveReceiptDefect(deps, resolveRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    for (const bad of [
      { quantity: 0 },
      { quantity: 1.5 },
      { kind: "EXCESS" as never },
      { outcome: "SOLD" as never },
      { evidence: "" },
      { resolvedBy: " " },
      { resolvedAt: "2999-01-01T00:00:00.000Z" },
    ]) {
      expect(codeOf(bad)).toBe("VALIDATION_ERROR");
    }
    expect(codeOf({ outcome: "DISCARDED", actorRole: "STAFF" })).toBe("FORBIDDEN");
    expect(codeOf({ receiptId: "no-such" })).toBe("NOT_FOUND");
    expect(codeOf({ tenantId: "tenant-b" })).toBe("NOT_FOUND");
    expect(saved).toEqual([]);
    expect(codeOf({ outcome: "DISCARDED", actorRole: "OWNER", quantity: 1 })).toBeUndefined();
  });

  it("처리 수량은 종류별로 입고 때 기록된 수량을 넘을 수 없고(누적 포함), 기록되지 않은 종류는 처리할 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const { deps, saved, resolveRequest } = defectScene(); // 파손 2, 오배송 1
    const codeOf = (extra: Partial<ResolveReceiptDefectRequest>) => {
      try {
        resolveReceiptDefect(deps, resolveRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ kind: "DAMAGED", quantity: 3 })).toBe("BUSINESS_INVARIANT");
    expect(codeOf({ kind: "MISDELIVERED", quantity: 2 })).toBe("BUSINESS_INVARIANT");
    expect(saved).toEqual([]);
    expect(codeOf({ kind: "DAMAGED", quantity: 1 })).toBeUndefined(); // 누적 1
    expect(codeOf({ kind: "DAMAGED", quantity: 2 })).toBe("BUSINESS_INVARIANT"); // 누적 3 > 2
    expect(codeOf({ kind: "DAMAGED", quantity: 1 })).toBeUndefined(); // 누적 2
    expect(codeOf({ kind: "MISDELIVERED", quantity: 1, outcome: "SUPPLIER_CREDIT" })).toBeUndefined();
    expect(saved).toHaveLength(3);
  });
});
