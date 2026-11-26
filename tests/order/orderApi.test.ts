import { describe, it, expect, vi } from "vitest";
import { createAnyBookRepository } from "../helpers/anyBookRepository";
import { createOrderApi } from "../../src/order/orderApi";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { createInMemoryMembershipRepository } from "../helpers/inMemoryMembershipRepository";

function setup() {
  const orderA = createDraftOrder({ tenantId: "tenant-a" });
  const orderB = createDraftOrder({ tenantId: "tenant-b" });
  const orders = createInMemoryOrderRepository([orderA, orderB]);
  const listSpy = vi.spyOn(orders, "list");
  const memberships = createInMemoryMembershipRepository([
    { userId: "owner-a", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
    { userId: "staff-a", tenantId: "tenant-a", role: "STAFF", status: "ACTIVE" },
    { userId: "ex-staff", tenantId: "tenant-a", role: "STAFF", status: "INACTIVE" },
  ]);
  let nextNumber = 0;
  const issueDisplayNumber = vi.fn((_tenantId: string) => ++nextNumber);
  const api = createOrderApi({
    books: createAnyBookRepository(),
    orders,
    memberships,
    idempotency: createIdempotencyStore(),
    issueDisplayNumber,
  });
  return { api, orderA, orderB, listSpy, issueDisplayNumber };
}

describe("createOrderApi (권한이 적용된 진입점)", () => {
  it("listOrders: 멤버에게는 자기 테넌트의 주문만 반환하고, 비멤버는 FORBIDDEN이며 저장소를 조회하지 않는다", () => {
    const { api, orderA, listSpy } = setup();

    const page = api.listOrders({ userId: "owner-a" }, { tenantId: "tenant-a" });
    expect(page.items.map((i) => i.id)).toEqual([orderA.id]);

    listSpy.mockClear();
    expect(() =>
      api.listOrders({ userId: "stranger" }, { tenantId: "tenant-a" }),
    ).toThrow(/^FORBIDDEN$/);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("createOrder: 활성 Owner·Staff는 만들 수 있고, 비멤버·비활성 멤버는 FORBIDDEN이며 아무것도 저장되지 않는다", () => {
    const { api } = setup();
    const lines = [{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }];

    const byOwner = api.createOrder(
      { userId: "owner-a" },
      { tenantId: "tenant-a", idempotencyKey: "k-owner", lines },
    );
    const byStaff = api.createOrder(
      { userId: "staff-a" },
      { tenantId: "tenant-a", idempotencyKey: "k-staff", lines },
    );
    expect(byOwner.status).toBe("DRAFT");
    expect(byStaff.status).toBe("DRAFT");

    for (const userId of ["stranger", "ex-staff"]) {
      expect(() =>
        api.createOrder(
          { userId },
          { tenantId: "tenant-a", idempotencyKey: `k-${userId}`, lines },
        ),
      ).toThrow(/^FORBIDDEN$/);
    }

    // setup의 tenant-a 기존 주문 1건 + 방금 만든 2건 = 3건, 거부된 요청은 저장되지 않음
    const count = api.listOrders(
      { userId: "owner-a" },
      { tenantId: "tenant-a", limit: 100 },
    ).items.length;
    expect(count).toBe(3);
  });

  it("confirmOrder: 활성 Owner·Staff는 확정할 수 있고, 비멤버·비활성 멤버는 FORBIDDEN이며 상태·번호 발급은 그대로다", () => {
    const { api, issueDisplayNumber } = setup();
    const lines = [{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }];
    const draft = (key: string) =>
      api.createOrder({ userId: "owner-a" }, { tenantId: "tenant-a", idempotencyKey: key, lines });
    const forOwner = draft("d-1");
    const forStaff = draft("d-2");
    const untouched = draft("d-3");

    const byOwner = api.confirmOrder(
      { userId: "owner-a" },
      { tenantId: "tenant-a", orderId: forOwner.id, expectedVersion: 1, idempotencyKey: "c-1" },
    );
    const byStaff = api.confirmOrder(
      { userId: "staff-a" },
      { tenantId: "tenant-a", orderId: forStaff.id, expectedVersion: 1, idempotencyKey: "c-2" },
    );
    expect(byOwner.status).toBe("CONFIRMED");
    expect(byStaff.status).toBe("CONFIRMED");
    expect(issueDisplayNumber).toHaveBeenCalledTimes(2);

    for (const userId of ["stranger", "ex-staff"]) {
      expect(() =>
        api.confirmOrder(
          { userId },
          { tenantId: "tenant-a", orderId: untouched.id, expectedVersion: 1, idempotencyKey: `c-${userId}` },
        ),
      ).toThrow(/^FORBIDDEN$/);
    }

    const after = api.getOrder(
      { userId: "owner-a" },
      { tenantId: "tenant-a", orderId: untouched.id },
    );
    expect(after.status).toBe("DRAFT");
    expect(after.version).toBe(1);
    expect(issueDisplayNumber).toHaveBeenCalledTimes(2); // 거부된 요청은 번호를 소모하지 않는다
  });

  it("createOrder: 비활성화된 직원이 성공했던 요청을 같은 멱등키로 재시도해도 FORBIDDEN이다 (BR-T06)", () => {
    const orders = createInMemoryOrderRepository();
    const idempotency = createIdempotencyStore();
    const lines = [{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }];
    const request = { tenantId: "tenant-a", idempotencyKey: "k-1", lines };
    const apiWith = (status: "ACTIVE" | "INACTIVE") =>
      createOrderApi({
        books: createAnyBookRepository(),
        orders,
        idempotency,
        issueDisplayNumber: () => 1,
        memberships: createInMemoryMembershipRepository([
          { userId: "staff-a", tenantId: "tenant-a", role: "STAFF", status },
        ]),
      });

    // 재직 중에 성공한 요청
    const created = apiWith("ACTIVE").createOrder({ userId: "staff-a" }, request);
    expect(created.status).toBe("DRAFT");

    // 비활성화 후 같은 키·같은 본문으로 재시도: 저장된 결과를 받아가면 안 된다
    expect(() =>
      apiWith("INACTIVE").createOrder({ userId: "staff-a" }, request),
    ).toThrow(/^FORBIDDEN$/);
  });

  it("getOrder: 멤버는 자기 주문 상세를 받고, 비멤버는 FORBIDDEN, 멤버가 타 테넌트 주문을 요청하면 NOT_FOUND", () => {
    const { api, orderA, orderB } = setup();

    const detail = api.getOrder(
      { userId: "owner-a" },
      { tenantId: "tenant-a", orderId: orderA.id },
    );
    expect(detail.id).toBe(orderA.id);

    expect(() =>
      api.getOrder(
        { userId: "stranger" },
        { tenantId: "tenant-a", orderId: orderA.id },
      ),
    ).toThrow(/^FORBIDDEN$/);

    // owner-a는 tenant-a 멤버지만 tenant-b의 주문 ID로 조회: 존재가 드러나면 안 된다
    expect(() =>
      api.getOrder(
        { userId: "owner-a" },
        { tenantId: "tenant-a", orderId: orderB.id },
      ),
    ).toThrow(/^NOT_FOUND$/);
  });

  it("holdOrder·resumeOrder·discardOrder: 활성 Owner·Staff만 할 수 있고(비멤버·비활성은 FORBIDDEN, 아무것도 바뀌지 않음), 담당자는 요청이 아니라 인증된 사용자로 기록된다", () => {
    const { api, orderA } = setup();
    const t = "2026-03-04T00:00:00.000Z";
    const lines = [{ bookId: "book-1", quantity: 1, unitPriceKrw: "15000" }];
    const draft = api.createOrder({ userId: "owner-a" }, { tenantId: "tenant-a", idempotencyKey: "k-draft", lines });

    for (const userId of ["stranger", "ex-staff"]) {
      expect(() => api.holdOrder({ userId }, { tenantId: "tenant-a", orderId: draft.id, expectedVersion: 1, reason: "r", heldAt: t, idempotencyKey: `h-${userId}` } as never)).toThrow(/^FORBIDDEN$/);
      expect(() => api.discardOrder({ userId }, { tenantId: "tenant-a", orderId: draft.id, expectedVersion: 1, reason: "r", discardedAt: t, idempotencyKey: `d-${userId}` } as never)).toThrow(/^FORBIDDEN$/);
    }
    expect(api.getOrder({ userId: "owner-a" }, { tenantId: "tenant-a", orderId: draft.id }).version).toBe(1);

    const held = api.holdOrder({ userId: "staff-a" }, { tenantId: "tenant-a", orderId: draft.id, expectedVersion: 1, reason: "확인", heldAt: t, heldBy: "위조", idempotencyKey: "h-1" } as never);
    expect(held).toMatchObject({ version: 2, heldAt: t, holdReason: "확인" });
    const resumed = api.resumeOrder({ userId: "owner-a" }, { tenantId: "tenant-a", orderId: draft.id, expectedVersion: 2, resumedAt: t, idempotencyKey: "r-1" } as never);
    expect(resumed.version).toBe(3);
    const discarded = api.discardOrder({ userId: "owner-a" }, { tenantId: "tenant-a", orderId: draft.id, expectedVersion: 3, reason: "철회", discardedAt: t, idempotencyKey: "d-1" } as never);
    expect(discarded).toMatchObject({ version: 4, discardedAt: t, discardReason: "철회" });
    expect(orderA.id).toBeDefined();
  });
});
