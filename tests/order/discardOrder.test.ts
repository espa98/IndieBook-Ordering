import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { holdOrder } from "../../src/order/holdOrder";
import { discardOrder } from "../../src/order/discardOrder";
import { confirmOrder } from "../../src/order/confirmOrder";
import { resumeOrder } from "../../src/order/resumeOrder";
import { thrown } from "../helpers/thrown";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";

const NOW = new Date("2026-03-04T07:00:00.000Z");

function scene() {
  const order = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" });
  const orders = createInMemoryOrderRepository([order]);
  const deps = { orders, idempotency: createIdempotencyStore(), now: () => NOW };
  let seq = 0;
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a", orderId: order.id, expectedVersion: order.version, reason: "고객이 주문을 철회함",
    discardedBy: "김직원", discardedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: `discard-${++seq}`, ...extra,
  });
  return { order, orders, deps, request };
}

describe("discardOrder: 초안 폐기 (ST-O09)", () => {
  it("초안을 폐기하면 version+1, 폐기 시각·사유·담당자가 기록되고 상태는 DRAFT 그대로이며 품목 등 이력은 보존된다", () => {
    const { order, orders, deps, request } = scene();

    const discarded = discardOrder(deps, request());

    expect(discarded).toMatchObject({
      id: order.id, status: "DRAFT", version: order.version + 1,
      discardedAt: "2026-03-04T06:50:00.000Z", discardReason: "고객이 주문을 철회함", discardedBy: "김직원",
    });
    expect(discarded.lines).toEqual(order.lines);
    expect(orders.get("tenant-a", order.id)).toEqual(discarded);
  });

  it("보류 중인 초안도 폐기할 수 있고, 폐기된 초안은 다시 폐기·보류·재개·확정할 수 없다(되돌릴 수 없다)", () => {
    const { order, orders, deps, request } = scene();
    const held = holdOrder(deps, { tenantId: "tenant-a", orderId: order.id, expectedVersion: order.version, reason: "확인 중", heldBy: "김직원", heldAt: "2026-03-04T06:00:00.000Z", idempotencyKey: "h1" });

    const discarded = discardOrder(deps, request({ expectedVersion: held.version }));
    expect(discarded).toMatchObject({ status: "DRAFT", discardedAt: "2026-03-04T06:50:00.000Z" });

    const v = discarded.version;
    expect(thrown(() => discardOrder(deps, request({ expectedVersion: v })))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(thrown(() => holdOrder(deps, { tenantId: "tenant-a", orderId: order.id, expectedVersion: v, reason: "다시", heldBy: "김직원", heldAt: "2026-03-04T06:55:00.000Z", idempotencyKey: "h2" }))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(thrown(() => resumeOrder(deps, { tenantId: "tenant-a", orderId: order.id, expectedVersion: v, resumedBy: "김직원", resumedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: "r1" }))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(thrown(() => confirmOrder(discarded, { expectedVersion: v, issueDisplayNumber: () => 1 }))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(orders.get("tenant-a", order.id)).toEqual(discarded);
  });

  it("확정된 주문·없는 주문·낡은 version은 거부되고, 잘못된 입력은 VALIDATION_ERROR이며 아무것도 바뀌지 않는다", () => {
    const { order, orders, deps, request } = scene();
    expect(thrown(() => discardOrder(deps, request({ expectedVersion: 99 })))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(thrown(() => discardOrder(deps, request({ orderId: "no-such-order" })))).toMatchObject({ code: "NOT_FOUND" });
    for (const bad of [{ reason: " " }, { reason: undefined }, { discardedBy: "" }, { discardedAt: "어제" }, { discardedAt: "2026-03-04T08:00:00.000Z" }, { expectedVersion: 0 }]) {
      expect(thrown(() => discardOrder(deps, request(bad))), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(orders.get("tenant-a", order.id)).toEqual(order);

    const confirmed = confirmOrder(order, { expectedVersion: 1, issueDisplayNumber: () => 1 });
    const other = createInMemoryOrderRepository([confirmed]);
    expect(thrown(() => discardOrder({ ...deps, orders: other }, request({ expectedVersion: confirmed.version })))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(other.get("tenant-a", order.id)).toEqual(confirmed);
  });
});
