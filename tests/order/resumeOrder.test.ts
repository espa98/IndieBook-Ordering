import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { holdOrder } from "../../src/order/holdOrder";
import { resumeOrder } from "../../src/order/resumeOrder";
import { confirmOrder } from "../../src/order/confirmOrder";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { thrown } from "../helpers/thrown";

const NOW = new Date("2026-03-04T07:00:00.000Z");

function scene() {
  const order = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" });
  const orders = createInMemoryOrderRepository([order]);
  const deps = { orders, idempotency: createIdempotencyStore(), now: () => NOW };
  let seq = 0;
  const held = holdOrder(deps, {
    tenantId: "tenant-a", orderId: order.id, expectedVersion: order.version, reason: "입금 일정 확인", heldBy: "김직원",
    heldAt: "2026-03-04T06:00:00.000Z", idempotencyKey: "hold-1",
  });
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a", orderId: order.id, expectedVersion: held.version, resumedBy: "이직원",
    resumedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: `resume-${++seq}`, ...extra,
  });
  return { order, held, orders, deps, request };
}

describe("resumeOrder: 보류 재개 (ST-O02)", () => {
  it("보류를 재개하면 보류 필드가 지워지고 version+1이며 상태는 DRAFT이고, 이제 확정할 수 있다", () => {
    const { order, held, orders, deps, request } = scene();

    const resumed = resumeOrder(deps, request());

    expect(resumed).toMatchObject({ id: order.id, status: "DRAFT", version: held.version + 1 });
    expect(resumed.heldAt).toBeUndefined();
    expect(resumed.holdReason).toBeUndefined();
    expect(resumed.heldBy).toBeUndefined();
    expect(orders.get("tenant-a", order.id)).toEqual(resumed);
    expect(confirmOrder(resumed, { expectedVersion: resumed.version, issueDisplayNumber: () => 1 }).status).toBe("CONFIRMED");
  });

  it("보류 중이 아닌 주문(초안·확정)·없는 주문·낡은 version은 거부되고, 잘못된 입력은 VALIDATION_ERROR이며 아무것도 바뀌지 않는다", () => {
    const { order, held, orders, deps, request } = scene();

    expect(thrown(() => resumeOrder(deps, request({ expectedVersion: 99 })))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(thrown(() => resumeOrder(deps, request({ orderId: "no-such-order" })))).toMatchObject({ code: "NOT_FOUND" });
    for (const bad of [{ resumedBy: " " }, { resumedAt: "어제" }, { resumedAt: "2026-03-04T08:00:00.000Z" }, { expectedVersion: 0 }]) {
      expect(thrown(() => resumeOrder(deps, request(bad))), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(orders.get("tenant-a", order.id)).toEqual(held);

    const resumed = resumeOrder(deps, request());
    // 이미 재개한 초안(보류 아님)은 다시 재개할 수 없다
    expect(thrown(() => resumeOrder(deps, request({ expectedVersion: resumed.version })))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    const confirmed = confirmOrder(resumed, { expectedVersion: resumed.version, issueDisplayNumber: () => 1 });
    const other = createInMemoryOrderRepository([confirmed]);
    expect(thrown(() => resumeOrder({ ...deps, orders: other }, request({ expectedVersion: confirmed.version })))).toMatchObject({ code: "BUSINESS_INVARIANT" });
  });
});
