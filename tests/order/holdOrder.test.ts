import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { holdOrder } from "../../src/order/holdOrder";
import { confirmOrder } from "../../src/order/confirmOrder";
import { thrown } from "../helpers/thrown";
import { AppError } from "../../src/errors/AppError";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";

const NOW = new Date("2026-03-04T07:00:00.000Z");

function draft() {
  return addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" });
}
function scene() {
  const order = draft();
  const orders = createInMemoryOrderRepository([order]);
  const deps = { orders, idempotency: createIdempotencyStore(), now: () => NOW };
  let seq = 0;
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    orderId: order.id,
    expectedVersion: order.version,
    reason: "고객이 입금 일정을 다시 알려주기로 함",
    heldBy: "김직원",
    heldAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `hold-${++seq}`,
    ...extra,
  });
  return { order, orders, deps, request };
}

describe("holdOrder: 초안 보류 (ST-O02)", () => {
  it("초안을 보류하면 version+1, 보류 시각·사유·담당자가 기록되고 상태는 DRAFT 그대로이며 저장소에 반영된다", () => {
    const { order, orders, deps, request } = scene();

    const held = holdOrder(deps, request());

    expect(held).toMatchObject({
      id: order.id,
      status: "DRAFT",
      version: order.version + 1,
      heldAt: "2026-03-04T06:50:00.000Z",
      holdReason: "고객이 입금 일정을 다시 알려주기로 함",
      heldBy: "김직원",
    });
    expect(orders.get("tenant-a", order.id)).toEqual(held);
  });

  it("확정된 주문·이미 보류 중인 초안은 보류할 수 없고(BUSINESS_INVARIANT), 없는 주문은 NOT_FOUND, 낡은 version은 VERSION_CONFLICT이며 아무것도 바뀌지 않는다", () => {
    const { order, orders, deps, request } = scene();

    expect(thrown(() => holdOrder(deps, request({ expectedVersion: 99 })))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(thrown(() => holdOrder(deps, request({ orderId: "no-such-order" })))).toMatchObject({ code: "NOT_FOUND" });
    expect(orders.get("tenant-a", order.id)).toEqual(order);

    const held = holdOrder(deps, request());
    expect(thrown(() => holdOrder(deps, request({ expectedVersion: held.version })))).toMatchObject({ code: "BUSINESS_INVARIANT" });

    const confirmed = confirmOrder(order, { expectedVersion: 1, issueDisplayNumber: () => 1 });
    const other = createInMemoryOrderRepository([confirmed]);
    const err = thrown(() => holdOrder({ ...deps, orders: other }, request({ expectedVersion: confirmed.version })));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(other.get("tenant-a", order.id)).toEqual(confirmed);
  });

  it("사유·담당자가 비었거나, 시각이 RFC3339 UTC가 아니거나 미래이거나, expectedVersion이 정수 1 이상이 아니면 VALIDATION_ERROR이고 아무것도 바뀌지 않는다", () => {
    const { order, orders, deps, request } = scene();
    for (const bad of [
      { reason: "  " },
      { reason: undefined },
      { heldBy: "" },
      { heldAt: "2026-03-04" },
      { heldAt: "2026-03-04T08:00:00.000Z" },
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
    ]) {
      expect(thrown(() => holdOrder(deps, request(bad))), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(orders.get("tenant-a", order.id)).toEqual(order);
  });

  it("같은 멱등 키·같은 본문은 같은 결과(한 번만 반영), 다른 본문은 IDEMPOTENCY_CONFLICT", () => {
    const { order, orders, deps, request } = scene();
    const first = holdOrder(deps, request({ idempotencyKey: "same" }));
    expect(holdOrder(deps, request({ idempotencyKey: "same" }))).toEqual(first);
    expect(orders.get("tenant-a", order.id)!.version).toBe(order.version + 1);
    expect(thrown(() => holdOrder(deps, request({ idempotencyKey: "same", reason: "다른 사유" })))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
