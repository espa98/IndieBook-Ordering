import { describe, it, expect } from "vitest";
import { registerCustomer, type RegisterCustomerRequest } from "../../src/customer/registerCustomer";
import { customerScene } from "../helpers/customerFixtures";

describe("registerCustomer: 고객 등록(최소 수집: 이름 + 전화번호) (C-02, 고객 결정 #1)", () => {
  it("직원이 이름과 전화번호로 등록하면 번호가 정규화되어 저장되고 등록 이력이 남는다", () => {
    const { deps, customers, changes, request } = customerScene();

    const { customer } = registerCustomer(deps, request());

    expect(customer).toEqual({ id: expect.any(String), tenantId: "tenant-a", name: "김독자", phone: "01012345678", version: 1 });
    expect(customers).toEqual([customer]);
    expect(changes).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", customerId: customer.id, kind: "REGISTERED", by: "staff-1", at: "2026-03-04T06:30:00.000Z" }),
    ]);
  });

  it("같은 서점에 같은 정규화 번호가 있으면 병합하지 않고 새로 만들며 중복 후보로 알려 준다(이름까지 같으면 강한 후보, 다른 서점은 후보 아님)", () => {
    const { deps, customers, request } = customerScene();
    const first = registerCustomer(deps, request()).customer;
    const other = registerCustomer(deps, request({ tenantId: "tenant-b" })).customer;

    const sameName = registerCustomer(deps, request({ phone: "+82 10 1234 5678" }));
    const diffName = registerCustomer(deps, request({ name: "박가족" }));

    expect(sameName.duplicateCandidates.map((d) => [d.customer.id, d.sameName])).toEqual([[first.id, true]]);
    expect(diffName.duplicateCandidates.map((d) => [d.customer.id, d.sameName])).toEqual([[first.id, false], [sameName.customer.id, false]]);
    expect(diffName.duplicateCandidates.some((d) => d.customer.id === other.id)).toBe(false);
    expect(customers).toHaveLength(4);
  });
  it("이름이 비었거나 번호·시각 형식이 틀리면 VALIDATION_ERROR이고 아무것도 저장하지 않는다", () => {
    const { deps, customers, changes, request } = customerScene();

    for (const bad of [{ name: " " }, { phone: "abc" }, { registeredBy: "" }, { registeredAt: "2999-01-01T00:00:00.000Z" }] as Partial<RegisterCustomerRequest>[]) {
      expect(() => registerCustomer(deps, request(bad)), JSON.stringify(bad)).toThrow(/VALIDATION_ERROR/);
    }
    expect(customers).toHaveLength(0);
    expect(changes).toHaveLength(0);
  });
});
