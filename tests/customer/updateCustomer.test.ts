import { describe, it, expect } from "vitest";
import { registerCustomer } from "../../src/customer/registerCustomer";
import { updateCustomer, type UpdateCustomerRequest } from "../../src/customer/updateCustomer";
import { customerScene } from "../helpers/customerFixtures";

function updateScene() {
  const scene = customerScene();
  const { customer } = registerCustomer(scene.deps, scene.request());
  let seq = 0;
  const update = (extra: Partial<UpdateCustomerRequest> = {}): UpdateCustomerRequest => ({
    tenantId: "tenant-a",
    customerId: customer.id,
    expectedVersion: 1,
    changes: { name: "김책방" },
    actorRole: "STAFF",
    changedBy: "staff-2",
    changedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: `upd-${++seq}`,
    ...extra,
  });
  return { ...scene, customer, update };
}

describe("updateCustomer: 고객 정보 수정 (C-03, 고객 결정 #8)", () => {
  it("이름·번호를 수정하면 버전이 1 오르고 변경 전·후 값이 담긴 UPDATED 이력이 남는다(번호는 정규화)", () => {
    const { deps, changes, customer, update } = updateScene();

    const updated = updateCustomer(deps, update({ changes: { name: " 김책방 ", phone: "+82 10 9999 0000" } }));

    expect(updated).toEqual({ ...customer, name: "김책방", phone: "01099990000", version: 2 });
    expect(deps.customers.get("tenant-a", customer.id)).toEqual(updated);
    expect(changes.at(-1)).toEqual(
      expect.objectContaining({
        kind: "UPDATED",
        customerId: customer.id,
        before: { name: "김독자", phone: "01012345678" },
        after: { name: "김책방", phone: "01099990000" },
        by: "staff-2",
        at: "2026-03-04T06:45:00.000Z",
      }),
    );
  });

  it("기대 버전이 다르면 VERSION_CONFLICT, 없는 고객(또는 다른 서점 고객)은 NOT_FOUND이고 아무것도 바뀌지 않는다", () => {
    const { deps, changes, customer, update } = updateScene();
    const before = changes.length;

    expect(() => updateCustomer(deps, update({ expectedVersion: 7 }))).toThrow(/VERSION_CONFLICT/);
    expect(() => updateCustomer(deps, update({ customerId: "00000000-0000-4000-8000-000000000000" }))).toThrow(/NOT_FOUND/);
    expect(() => updateCustomer(deps, update({ tenantId: "tenant-b" }))).toThrow(/NOT_FOUND/);
    expect(deps.customers.get("tenant-a", customer.id)).toEqual(customer);
    expect(changes).toHaveLength(before);
  });

  it("변경 항목이 없거나 이름·번호·버전·행위자·시각 형식이 틀리면 VALIDATION_ERROR이고 아무것도 저장하지 않는다", () => {
    const { deps, changes, customer, update } = updateScene();
    const before = changes.length;

    for (const bad of [
      { changes: {} },
      { changes: { name: " " } },
      { changes: { phone: "abc" } },
      { expectedVersion: 0 },
      { changedBy: "" },
      { changedAt: "2999-01-01T00:00:00.000Z" },
    ] as Partial<UpdateCustomerRequest>[]) {
      expect(() => updateCustomer(deps, update(bad)), JSON.stringify(bad)).toThrow(/VALIDATION_ERROR/);
    }
    expect(deps.customers.get("tenant-a", customer.id)).toEqual(customer);
    expect(changes).toHaveLength(before);
  });
});
