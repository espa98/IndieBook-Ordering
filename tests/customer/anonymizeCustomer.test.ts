import { describe, it, expect } from "vitest";
import { anonymizeCustomer, type AnonymizeCustomerRequest } from "../../src/customer/anonymizeCustomer";
import { updateCustomer } from "../../src/customer/updateCustomer";
import { registerCustomer } from "../../src/customer/registerCustomer";
import { customerScene } from "../helpers/customerFixtures";

function anonymizeScene() {
  const scene = customerScene();
  const { customer } = registerCustomer(scene.deps, scene.request());
  let seq = 0;
  const anonymize = (extra: Partial<AnonymizeCustomerRequest> = {}): AnonymizeCustomerRequest => ({
    tenantId: "tenant-a",
    customerId: customer.id,
    expectedVersion: 1,
    actorRole: "OWNER",
    anonymizedBy: "owner-1",
    anonymizedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `anon-${++seq}`,
    ...extra,
  });
  return { ...scene, customer, anonymize };
}

describe("anonymizeCustomer: 삭제 요청은 익명화한다 (고객 결정 #2, #10)", () => {
  it("Owner가 익명화하면 이름·번호가 비식별화되고 ID·버전 이력은 유지되며 ANONYMIZED 이력이 남는다", () => {
    const { deps, changes, customer, anonymize } = anonymizeScene();

    const result = anonymizeCustomer(deps, anonymize());

    expect(result).toEqual({ id: customer.id, tenantId: "tenant-a", name: "(익명)", phone: null, anonymizedAt: "2026-03-04T06:50:00.000Z", version: 2 });
    expect(deps.customers.get("tenant-a", customer.id)).toEqual(result);
    expect(changes.at(-1)).toEqual(
      expect.objectContaining({ kind: "ANONYMIZED", customerId: customer.id, before: { name: "김독자", phone: "01012345678" }, after: { name: "(익명)", phone: null }, by: "owner-1" }),
    );
    expect(deps.customers.listByPhone("tenant-a", "01012345678")).toEqual([]);
  });

  it("이미 익명화된 고객은 다시 익명화하거나 수정할 수 없다(BUSINESS_INVARIANT)", () => {
    const { deps, changes, customer, anonymize } = anonymizeScene();
    anonymizeCustomer(deps, anonymize());
    const before = changes.length;

    expect(() => anonymizeCustomer(deps, anonymize({ expectedVersion: 2 }))).toThrow(/BUSINESS_INVARIANT/);
    expect(() =>
      updateCustomer(deps, { tenantId: "tenant-a", customerId: customer.id, expectedVersion: 2, changes: { name: "복구" }, actorRole: "STAFF", changedBy: "staff-1", changedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: "x-1" }),
    ).toThrow(/BUSINESS_INVARIANT/);
    expect(changes).toHaveLength(before);
  });

  it("버전 충돌은 VERSION_CONFLICT, 없는 고객은 NOT_FOUND, 형식 오류는 VALIDATION_ERROR이다", () => {
    const { deps, changes, anonymize } = anonymizeScene();
    const before = changes.length;

    expect(() => anonymizeCustomer(deps, anonymize({ expectedVersion: 9 }))).toThrow(/VERSION_CONFLICT/);
    expect(() => anonymizeCustomer(deps, anonymize({ customerId: "00000000-0000-4000-8000-000000000000" }))).toThrow(/NOT_FOUND/);
    expect(() => anonymizeCustomer(deps, anonymize({ anonymizedBy: "" }))).toThrow(/VALIDATION_ERROR/);
    expect(() => anonymizeCustomer(deps, anonymize({ anonymizedAt: "2999-01-01T00:00:00.000Z" }))).toThrow(/VALIDATION_ERROR/);
    expect(changes).toHaveLength(before);
  });
});
