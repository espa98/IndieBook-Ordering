import { describe, it, expect } from "vitest";
import { registerSupplier } from "../../src/catalog/registerSupplier";
import type { RegisterSupplierRequest } from "../../src/catalog/registerSupplier";
import { AppError } from "../../src/errors/AppError";
import { supplierScene } from "../helpers/supplierFixtures";

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
};

describe("registerSupplier: 공급처 등록과 발주 방식 기록 (SUP-001/002, ST-B04)", () => {
  it("Owner가 공급처를 이름·발주 방식과 함께 등록하면 활성 공급처와 등록 이력이 만들어진다", () => {
    const { deps, suppliers, changes, registerRequest } = supplierScene();

    const supplier = registerSupplier(deps, registerRequest());

    expect(supplier).toEqual({
      tenantId: "tenant-a",
      code: "sup-x",
      active: true,
      name: "엑스도매",
      orderChannel: "EMAIL",
      version: 1,
    });
    expect(suppliers.get("tenant-a", "sup-x")).toEqual(supplier);
    expect(changes).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", code: "sup-x", kind: "REGISTERED", by: "owner-1", at: "2026-03-04T06:30:00.000Z" }),
    ]);
  });

  it("점주가 위임한 직원은 등록할 수 있고 위임받지 않은 직원은 FORBIDDEN 403이다", () => {
    const { deps, registerRequest } = supplierScene();

    expect(
      codeOf(() => registerSupplier(deps, registerRequest({ actorRole: "STAFF", registeredBy: "staff-delegated", code: "sup-d" }))),
    ).toBeUndefined();
    expect(codeOf(() => registerSupplier(deps, registerRequest({ actorRole: "STAFF", registeredBy: "staff-other", code: "sup-e" })))).toBe(
      "FORBIDDEN",
    );
    expect(deps.suppliers.get("tenant-a", "sup-e")).toBeUndefined();
  });

  it("코드가 같은 공급처는 중복으로 거부하고(다른 테넌트는 허용), 코드·이름·발주 방식 형식 오류는 VALIDATION_ERROR 400이다", () => {
    const { deps, changes, registerRequest } = supplierScene();
    registerSupplier(deps, registerRequest());

    expect(codeOf(() => registerSupplier(deps, registerRequest({ name: "다른 이름" })))).toBe("BUSINESS_INVARIANT");
    expect(codeOf(() => registerSupplier(deps, registerRequest({ tenantId: "tenant-b", actorRole: "OWNER" })))).toBeUndefined();
    const before = changes.length;
    for (const bad of [
      { code: "" },
      { code: "Has Space" },
      { name: " " },
      { orderChannel: "FAX" as never },
      { registeredBy: "" },
      { registeredAt: "2999-01-01T00:00:00.000Z" },
    ] as Partial<RegisterSupplierRequest>[]) {
      expect(codeOf(() => registerSupplier(deps, registerRequest({ code: "sup-y", ...bad }))), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect(changes).toHaveLength(before);
  });
});
