import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createDraftOrder (ST-O01: 없음 → DRAFT)", () => {
  it("테넌트에 연결된 UUID의 DRAFT 주문을 만든다", () => {
    const order = createDraftOrder({ tenantId: "tenant-a" });

    expect(order.id).toMatch(UUID_RE);
    expect(order.tenantId).toBe("tenant-a");
    expect(order.status).toBe("DRAFT");
  });

  it("tenantId가 비어 있으면 거부한다", () => {
    expect(() => createDraftOrder({ tenantId: "" })).toThrow(/tenantId/);
    expect(() => createDraftOrder({ tenantId: "   " })).toThrow(/tenantId/);
  });
});
