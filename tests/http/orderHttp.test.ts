import { describe, it, expect, vi } from "vitest";
import { handle } from "../../src/http/handle";
import { createOrderApi } from "../../src/order/orderApi";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { createInMemoryMembershipRepository } from "../helpers/inMemoryMembershipRepository";

/** 권한 → 서비스 → 도메인 → AppError → HTTP 응답까지 한 줄로 이어지는지 확인하는 통합 테스트 */
function setup() {
  let nextNumber = 0;
  const api = createOrderApi({
    orders: createInMemoryOrderRepository(),
    idempotency: createIdempotencyStore(),
    issueDisplayNumber: () => ++nextNumber,
    memberships: createInMemoryMembershipRepository([
      { userId: "owner-a", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
      { userId: "ex-staff", tenantId: "tenant-a", role: "STAFF", status: "INACTIVE" },
      { userId: "owner-b", tenantId: "tenant-b", role: "OWNER", status: "ACTIVE" },
    ]),
  });
  const onUnexpectedError = vi.fn();
  return { api, onUnexpectedError };
}

const lines = [{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }];

describe("주문 API 통합 (진입점 + handle)", () => {
  it("생성 201 → 상세 200 → 확정 200 → 목록 200이 이어지고 응답 본문은 { data }이다", () => {
    const { api, onUnexpectedError } = setup();
    const opts = { onUnexpectedError };
    const owner = { userId: "owner-a" };

    const created = handle(
      () => api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k-1", lines }),
      { ...opts, successStatus: 201 },
    );
    expect(created.status).toBe(201);
    const orderId = (created.body as { data: { id: string } }).data.id;

    const detail = handle(
      () => api.getOrder(owner, { tenantId: "tenant-a", orderId }),
      opts,
    );
    expect(detail.status).toBe(200);

    const confirmed = handle(
      () =>
        api.confirmOrder(owner, {
          tenantId: "tenant-a",
          orderId,
          expectedVersion: 1,
          idempotencyKey: "c-1",
        }),
      opts,
    );
    expect(confirmed.status).toBe(200);
    expect(
      (confirmed.body as { data: { status: string; totalKrw: string } }).data,
    ).toMatchObject({ status: "CONFIRMED", totalKrw: "30000" });

    const list = handle(
      () => api.listOrders(owner, { tenantId: "tenant-a", status: "CONFIRMED" }),
      opts,
    );
    expect(list.status).toBe(200);
    expect((list.body as { data: { items: unknown[] } }).data.items).toHaveLength(1);
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it.each([
    [
      "비활성 직원이 생성 → 403",
      { userId: "ex-staff" },
      { tenantId: "tenant-a", idempotencyKey: "k", lines },
      403,
      "FORBIDDEN",
    ],
    [
      "타 테넌트 멤버가 생성 → 403",
      { userId: "owner-b" },
      { tenantId: "tenant-a", idempotencyKey: "k", lines },
      403,
      "FORBIDDEN",
    ],
    [
      "인증 없음 → 401",
      { userId: "" },
      { tenantId: "tenant-a", idempotencyKey: "k", lines },
      401,
      "UNAUTHENTICATED",
    ],
    [
      "잘못된 수량 → 400",
      { userId: "owner-a" },
      {
        tenantId: "tenant-a",
        idempotencyKey: "k",
        lines: [{ bookId: "b", quantity: 0, unitPriceKrw: "1000" }],
      },
      400,
      "VALIDATION_ERROR",
    ],
  ] as const)("%s", (_name, actor, request, status, code) => {
    const { api, onUnexpectedError } = setup();

    const response = handle(() => api.createOrder(actor, { ...request, lines: [...request.lines] }), {
      onUnexpectedError,
      successStatus: 201,
    });

    expect(response.status).toBe(status);
    expect((response.body as { error: { code: string } }).error.code).toBe(code);
    expect(onUnexpectedError).not.toHaveBeenCalled(); // 예상된 오류는 로깅 대상이 아니다
  });

  it("없는 주문 → 404, 타 테넌트 주문 ID도 같은 404 (존재 비노출)", () => {
    const { api } = setup();
    const ownerA = { userId: "owner-a" };
    const ownerB = { userId: "owner-b" };
    const orderOfB = handle(
      () => api.createOrder(ownerB, { tenantId: "tenant-b", idempotencyKey: "k", lines }),
      { successStatus: 201 },
    );
    const orderIdOfB = (orderOfB.body as { data: { id: string } }).data.id;

    const missing = handle(() =>
      api.getOrder(ownerA, { tenantId: "tenant-a", orderId: "missing" }),
    );
    const crossTenant = handle(() =>
      api.getOrder(ownerA, { tenantId: "tenant-a", orderId: orderIdOfB }),
    );

    expect(missing.status).toBe(404);
    expect(crossTenant).toEqual(missing); // 응답이 완전히 동일해야 존재 여부가 드러나지 않는다
  });

  it("버전 불일치 → 409, 재확정 → 422, 같은 키·다른 본문 → 409", () => {
    const { api } = setup();
    const owner = { userId: "owner-a" };
    const created = api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k-1", lines });
    const base = { tenantId: "tenant-a", orderId: created.id };

    const stale = handle(() =>
      api.confirmOrder(owner, { ...base, expectedVersion: 99, idempotencyKey: "c-1" }),
    );
    handle(() =>
      api.confirmOrder(owner, { ...base, expectedVersion: 1, idempotencyKey: "c-2" }),
    );
    const again = handle(() =>
      api.confirmOrder(owner, { ...base, expectedVersion: 2, idempotencyKey: "c-3" }),
    );
    const keyReuse = handle(() =>
      api.confirmOrder(owner, { ...base, expectedVersion: 2, idempotencyKey: "c-2" }),
    );

    expect([stale.status, (stale.body as { error: { code: string } }).error.code]).toEqual([
      409,
      "VERSION_CONFLICT",
    ]);
    expect([again.status, (again.body as { error: { code: string } }).error.code]).toEqual([
      422,
      "BUSINESS_INVARIANT",
    ]);
    expect([keyReuse.status, (keyReuse.body as { error: { code: string } }).error.code]).toEqual([
      409,
      "IDEMPOTENCY_CONFLICT",
    ]);
  });
});
