import { describe, it, expect } from "vitest";
import { linkOrderCustomer, type LinkOrderCustomerRequest, type OrderCustomerLink } from "../../src/customer/linkOrderCustomer";
import { anonymizeCustomer } from "../../src/customer/anonymizeCustomer";
import { registerCustomer } from "../../src/customer/registerCustomer";
import { customerScene } from "../helpers/customerFixtures";

type OrderStub = { id: string; closedAt?: string; cancelledAt?: string; discardedAt?: string };

function linkScene(orders: OrderStub[] = [{ id: "order-1" }]) {
  const scene = customerScene();
  const { customer } = registerCustomer(scene.deps, scene.request());
  const links: OrderCustomerLink[] = [];
  const deps = {
    customers: scene.deps.customers,
    orders: { get: (tenantId: string, id: string) => (tenantId === "tenant-a" ? orders.find((o) => o.id === id) : undefined) },
    orderCustomerLinks: {
      current: (tenantId: string, orderId: string) => links.filter((l) => l.tenantId === tenantId && l.orderId === orderId).at(-1),
      save: (l: OrderCustomerLink) => void links.push(l),
    },
    idempotency: scene.deps.idempotency,
    now: scene.deps.now,
  };
  let seq = 0;
  const link = (extra: Partial<LinkOrderCustomerRequest> = {}): LinkOrderCustomerRequest => ({
    tenantId: "tenant-a",
    orderId: "order-1",
    customerId: customer.id,
    actorRole: "STAFF",
    linkedBy: "staff-1",
    linkedAt: "2026-03-04T06:40:00.000Z",
    idempotencyKey: `lnk-${++seq}`,
    ...extra,
  });
  return { ...scene, deps, customer, links, link };
}

describe("linkOrderCustomer: 주문에 고객 연결(선택) (고객 결정 #4)", () => {
  it("직원이 주문에 고객을 연결하면 연결 기록이 남는다", () => {
    const { deps, links, customer, link } = linkScene();

    const result = linkOrderCustomer(deps, link());

    expect(result).toEqual({ id: expect.any(String), tenantId: "tenant-a", orderId: "order-1", customerId: customer.id, linkedBy: "staff-1", linkedAt: "2026-03-04T06:40:00.000Z" });
    expect(links).toEqual([result]);
  });

  it("없는 주문·고객(다른 서점 포함)은 NOT_FOUND, 폐기·취소·종결된 주문과 익명화된 고객은 BUSINESS_INVARIANT이며 아무것도 저장하지 않는다", () => {
    const { deps, links, customer, link } = linkScene([{ id: "order-1" }, { id: "discarded", discardedAt: "x" }, { id: "cancelled", cancelledAt: "x" }, { id: "closed", closedAt: "x" }]);

    expect(() => linkOrderCustomer(deps, link({ orderId: "missing" }))).toThrow(/NOT_FOUND/);
    expect(() => linkOrderCustomer(deps, link({ customerId: "00000000-0000-4000-8000-000000000000" }))).toThrow(/NOT_FOUND/);
    expect(() => linkOrderCustomer(deps, link({ tenantId: "tenant-b" }))).toThrow(/NOT_FOUND/);
    for (const orderId of ["discarded", "cancelled", "closed"]) expect(() => linkOrderCustomer(deps, link({ orderId })), orderId).toThrow(/BUSINESS_INVARIANT/);
    anonymizeCustomer({ ...deps, customerChanges: { save: () => undefined } }, { tenantId: "tenant-a", customerId: customer.id, expectedVersion: 1, actorRole: "OWNER", anonymizedBy: "owner-1", anonymizedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: "an-1" });
    expect(() => linkOrderCustomer(deps, link())).toThrow(/BUSINESS_INVARIANT/);
    expect(links).toHaveLength(0);
  });

  it("형식 오류(행위자·시각·ID)는 VALIDATION_ERROR이다", () => {
    const { deps, links, link } = linkScene();

    for (const bad of [{ linkedBy: "" }, { linkedAt: "2999-01-01T00:00:00.000Z" }, { orderId: "" }, { customerId: "" }] as Partial<LinkOrderCustomerRequest>[]) {
      expect(() => linkOrderCustomer(deps, link(bad)), JSON.stringify(bad)).toThrow(/VALIDATION_ERROR/);
    }
    expect(links).toHaveLength(0);
  });

  it("이미 같은 고객이 연결돼 있으면 새 기록 없이 현재 연결을 돌려주고, 다른 고객으로 바꾸면 새 연결이 추가된다(이전 연결은 이력으로 남는다)", () => {
    const { deps, links, customer, link, request } = linkScene();
    const other = registerCustomer({ ...deps, customerChanges: { save: () => undefined } }, request({ name: "다른고객", phone: "010-1111-2222" })).customer;

    const first = linkOrderCustomer(deps, link());
    const again = linkOrderCustomer(deps, link());
    const changed = linkOrderCustomer(deps, link({ customerId: other.id }));

    expect(again).toEqual(first);
    expect(changed.customerId).toBe(other.id);
    expect(links.map((l) => l.customerId)).toEqual([customer.id, other.id]);
  });
});
