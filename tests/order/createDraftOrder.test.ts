import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createDraftOrder (ST-O01: 없음 → DRAFT)", () => {
  it("테넌트에 연결된 UUID의 DRAFT 주문을 만든다", () => {
    const order = createDraftOrder({ tenantId: "tenant-a" });

    expect(order.id).toMatch(UUID_RE);
    expect(order.tenantId).toBe("tenant-a");
    expect(order.status).toBe("DRAFT");
  });

  it("생성 시각을 ISO 문자열 createdAt으로 기록한다 (now 주입 가능)", () => {
    const order = createDraftOrder({
      tenantId: "tenant-a",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(order.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("빈 tenantId는 AppError(VALIDATION_ERROR, HTTP 400)이고 메시지에 tenantId가 드러난다", () => {
    const error = thrown(() => createDraftOrder({ tenantId: "" }));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("VALIDATION_ERROR");
    expect((error as AppError).httpStatus).toBe(400);
    expect((error as AppError).message).toMatch(/^VALIDATION_ERROR: .*tenantId/);
  });

  it("tenantId가 비어 있으면 거부한다", () => {
    expect(() => createDraftOrder({ tenantId: "" })).toThrow(/tenantId/);
    expect(() => createDraftOrder({ tenantId: "   " })).toThrow(/tenantId/);
  });
});
