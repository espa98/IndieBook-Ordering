import { describe, it, expect, vi } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { confirmOrderService } from "../../src/order/confirmOrderService";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";

function draftWithLine(tenantId = "tenant-a") {
  return addOrderLine(createDraftOrder({ tenantId }), {
    bookId: "book-1",
    quantity: 1,
    unitPriceKrw: "15000",
  });
}

describe("confirmOrderService", () => {
  it("저장소에서 초안을 읽어 확정하고 저장한 뒤 결과를 반환한다", () => {
    const draft = draftWithLine();
    const orders = createInMemoryOrderRepository([draft]);

    const confirmed = confirmOrderService(
      {
        orders,
        idempotency: createIdempotencyStore(),
        issueDisplayNumber: () => 7,
      },
      {
        tenantId: "tenant-a",
        orderId: draft.id,
        expectedVersion: 1,
        idempotencyKey: "key-1",
      },
    );

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.displayNumber).toBe(7);
    expect(orders.get("tenant-a", draft.id)).toEqual(confirmed);
  });

  it("같은 멱등키·같은 본문으로 재시도하면 같은 주문과 같은 번호를 반환하고 번호를 새로 발급하지 않는다", () => {
    const draft = draftWithLine();
    const orders = createInMemoryOrderRepository([draft]);
    const issueDisplayNumber = vi.fn((_tenantId: string) => 7);
    const deps = {
      orders,
      idempotency: createIdempotencyStore(),
      issueDisplayNumber,
    };
    const request = {
      tenantId: "tenant-a",
      orderId: draft.id,
      expectedVersion: 1,
      idempotencyKey: "key-1",
    };

    const first = confirmOrderService(deps, request);
    const retry = confirmOrderService(deps, request);

    expect(retry).toEqual(first);
    expect(retry.displayNumber).toBe(7);
    expect(retry.version).toBe(2);
    expect(issueDisplayNumber).toHaveBeenCalledTimes(1);
  });

  it("같은 멱등키에 다른 본문(expectedVersion)이면 IDEMPOTENCY_CONFLICT이고 주문은 바뀌지 않는다", () => {
    const draft = draftWithLine();
    const orders = createInMemoryOrderRepository([draft]);
    const issueDisplayNumber = vi.fn((_tenantId: string) => 7);
    const deps = {
      orders,
      idempotency: createIdempotencyStore(),
      issueDisplayNumber,
    };
    const base = {
      tenantId: "tenant-a",
      orderId: draft.id,
      idempotencyKey: "key-1",
    };

    const first = confirmOrderService(deps, { ...base, expectedVersion: 1 });

    expect(() =>
      confirmOrderService(deps, { ...base, expectedVersion: 2 }),
    ).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(orders.get("tenant-a", draft.id)).toEqual(first);
    expect(issueDisplayNumber).toHaveBeenCalledTimes(1);
  });

  it("없는 주문이거나 다른 테넌트의 주문이면 NOT_FOUND이고 번호를 발급하지 않는다", () => {
    const tenantBOrder = draftWithLine("tenant-b");
    const orders = createInMemoryOrderRepository([tenantBOrder]);
    const issueDisplayNumber = vi.fn((_tenantId: string) => 1);
    const deps = {
      orders,
      idempotency: createIdempotencyStore(),
      issueDisplayNumber,
    };

    // 존재하지 않는 주문 ID
    expect(() =>
      confirmOrderService(deps, {
        tenantId: "tenant-a",
        orderId: "00000000-0000-4000-8000-000000000000",
        expectedVersion: 1,
        idempotencyKey: "key-1",
      }),
    ).toThrow(/NOT_FOUND/);

    // tenant-a가 tenant-b의 주문 ID로 접근
    expect(() =>
      confirmOrderService(deps, {
        tenantId: "tenant-a",
        orderId: tenantBOrder.id,
        expectedVersion: 1,
        idempotencyKey: "key-2",
      }),
    ).toThrow(/NOT_FOUND/);

    expect(issueDisplayNumber).not.toHaveBeenCalled();
    expect(orders.get("tenant-b", tenantBOrder.id)?.status).toBe("DRAFT");
  });
});
