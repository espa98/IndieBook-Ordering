import { describe, it, expect } from "vitest";
import { registerSupplier } from "../../src/catalog/registerSupplier";
import { setSupplierActive } from "../../src/catalog/setSupplierActive";
import type { SetSupplierActiveRequest } from "../../src/catalog/setSupplierActive";
import { updateSupplier } from "../../src/catalog/updateSupplier";
import type { UpdateSupplierRequest } from "../../src/catalog/updateSupplier";
import { AppError } from "../../src/errors/AppError";
import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { sentScene } from "../helpers/procurementWorld";
import { supplierScene } from "../helpers/supplierFixtures";

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
};

function updateScene() {
  const s = supplierScene();
  const supplier = registerSupplier(s.deps, s.registerRequest());
  let seq = 0;
  const updateRequest = (extra: Partial<UpdateSupplierRequest> = {}): UpdateSupplierRequest => ({
    tenantId: "tenant-a",
    code: supplier.code,
    expectedVersion: supplier.version!,
    changes: { orderChannel: "PHONE" },
    reason: "이메일 대신 전화 주문으로 변경",
    actorRole: "OWNER",
    changedBy: "owner-1",
    changedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: `usup-${++seq}`,
    ...extra,
  });
  return { ...s, supplier, updateRequest };
}

describe("updateSupplier: 공급처 수정 (ST-B04, SUP-002)", () => {
  it("발주 방식을 바꾸면 version+1이 되고 이전 값이 이력에 남는다", () => {
    const { deps, changes, supplier, updateRequest } = updateScene();

    const updated = updateSupplier(deps, updateRequest());

    expect(updated).toMatchObject({ code: "sup-x", orderChannel: "PHONE", name: "엑스도매", version: 2, active: true });
    expect(changes.at(-1)).toMatchObject({
      kind: "UPDATED",
      before: { name: "엑스도매", orderChannel: "EMAIL", active: true },
      after: { name: "엑스도매", orderChannel: "PHONE", active: true },
      reason: "이메일 대신 전화 주문으로 변경",
      by: "owner-1",
    });
    expect(supplier.version).toBe(1); // 이전 객체는 그대로
  });

  it("위임받지 않은 직원은 FORBIDDEN, version이 다르면 VERSION_CONFLICT, 없는 공급처는 NOT_FOUND, 변경이 없거나 형식이 틀리면 VALIDATION_ERROR이며 이력이 늘지 않는다", () => {
    const { deps, changes, updateRequest } = updateScene();
    const before = changes.length;

    expect(codeOf(() => updateSupplier(deps, updateRequest({ actorRole: "STAFF", changedBy: "staff-other" })))).toBe("FORBIDDEN");
    expect(codeOf(() => updateSupplier(deps, updateRequest({ expectedVersion: 7 })))).toBe("VERSION_CONFLICT");
    expect(codeOf(() => updateSupplier(deps, updateRequest({ code: "no-such" })))).toBe("NOT_FOUND");
    expect(codeOf(() => updateSupplier(deps, updateRequest({ tenantId: "tenant-b" })))).toBe("NOT_FOUND");
    for (const bad of [{ changes: {} }, { changes: { name: " " } }, { changes: { orderChannel: "FAX" as never } }, { reason: "" }]) {
      expect(codeOf(() => updateSupplier(deps, updateRequest(bad))), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect(changes).toHaveLength(before);
    expect(codeOf(() => updateSupplier(deps, updateRequest({ actorRole: "STAFF", changedBy: "staff-delegated" })))).toBeUndefined();
  });
});

describe("setSupplierActive: 공급처 비활성화·복구 (ST-B04)", () => {
  function activeScene() {
    const scene = sentScene(); // sup-a에 SENT 발주(6권)가 있다
    const changes: ReturnType<typeof supplierScene>["changes"] = [];
    const deps = {
      suppliers: scene.w.deps.suppliers,
      purchaseOrders: scene.w.deps.purchaseOrders,
      supplierChanges: { save: (c: (typeof changes)[number]) => void changes.push(c) },
      managementDelegations: { isDelegated: () => false },
      idempotency: scene.w.deps.idempotency,
      now: () => new Date("2026-03-04T07:00:00.000Z"),
    };
    let seq = 0;
    const activeRequest = (extra: Partial<SetSupplierActiveRequest> = {}): SetSupplierActiveRequest => ({
      tenantId: "tenant-a",
      code: "sup-a",
      active: false,
      reason: "거래 중단",
      actorRole: "OWNER",
      changedBy: "owner-1",
      changedAt: "2026-03-04T06:50:00.000Z",
      idempotencyKey: `sact-${++seq}`,
      ...extra,
    });
    return { scene, deps, changes, activeRequest };
  }

  it("비활성화하면 신규 조달 배정이 차단되고, 진행 중 발주는 그대로 보존되며 이력에 그 발주가 기록된다. 복구하면 다시 배정할 수 있다", () => {
    const { scene, deps, changes, activeRequest } = activeScene();
    const poBefore = structuredClone(scene.w.deps.purchaseOrders.get("tenant-a", scene.sent.id));
    const order = scene.w.addOrder([{ bookId: "book-9", quantity: 1, unitPriceKrw: "9000" }]);
    const allocate = (key: string) =>
      allocateSourcing(scene.w.deps, {
        tenantId: "tenant-a",
        orderId: order.id,
        lineId: order.lines[0]!.lineId,
        supplierCode: "sup-a",
        quantity: 1,
        idempotencyKey: key,
      });

    const off = setSupplierActive(deps, activeRequest());

    expect(off).toMatchObject({ code: "sup-a", active: false, version: 2 });
    expect(changes.at(-1)).toMatchObject({ kind: "DEACTIVATED", openPurchaseOrderIds: [scene.sent.id], reason: "거래 중단" });
    expect(scene.w.deps.purchaseOrders.get("tenant-a", scene.sent.id)).toEqual(poBefore); // 과거 발주 보존
    expect(codeOf(() => allocate("al-off"))).toBe("BUSINESS_INVARIANT");

    const on = setSupplierActive(deps, activeRequest({ active: true, reason: "거래 재개" }));
    expect(on).toMatchObject({ active: true, version: 3 });
    expect(changes.at(-1)).toMatchObject({ kind: "REACTIVATED" });
    expect(codeOf(() => allocate("al-on"))).toBeUndefined();
  });

  it("이미 같은 상태이거나 위임 없는 직원이거나 사유가 비었으면 거부하고 이력이 늘지 않는다", () => {
    const { deps, changes, activeRequest } = activeScene();

    expect(codeOf(() => setSupplierActive(deps, activeRequest({ active: true })))).toBe("BUSINESS_INVARIANT");
    expect(codeOf(() => setSupplierActive(deps, activeRequest({ actorRole: "STAFF", changedBy: "staff-1" })))).toBe("FORBIDDEN");
    expect(codeOf(() => setSupplierActive(deps, activeRequest({ reason: "" })))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => setSupplierActive(deps, activeRequest({ code: "no-such" })))).toBe("NOT_FOUND");
    expect(changes).toEqual([]);
  });
});
