import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { correctFulfillment } from "../../src/fulfillment/correctFulfillment";
import type {
  CorrectFulfillmentRequest,
  FulfillmentCorrection,
} from "../../src/fulfillment/correctFulfillment";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { readReservationLedger } from "../../src/inventory/stockReservation";
import { stockLevel } from "../../src/inventory/stockLevel";
import { executeOrderReopening } from "../../src/order/executeOrderReopening";
import { fulfillmentScene } from "../helpers/fulfillmentFixtures";
import { reopeningScene } from "../helpers/closureFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 주문 D 결제 확인 후 예약 2권을 전량 인도한 세계에서 수령 정정을 다룬다 */
function correctionScene() {
  const s = fulfillmentScene();
  s.pay(s.orderD.id, "30000");
  const fulfillment = postFulfillment(
    s.deps,
    s.fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: s.reservation.id, quantity: 2 }] }),
  );
  const fulfillmentCorrections: FulfillmentCorrection[] = [];
  const deps = {
    ...s.deps,
    fulfillmentCorrections: {
      list: (tenantId: string, orderId: string) =>
        fulfillmentCorrections.filter((c) => c.tenantId === tenantId && c.orderId === orderId),
      save: (c: FulfillmentCorrection) => void fulfillmentCorrections.push(c),
    },
  };
  let seq = 0;
  const correctRequest = (extra: Partial<CorrectFulfillmentRequest> = {}): CorrectFulfillmentRequest => ({
    tenantId: "tenant-a",
    orderId: s.orderD.id,
    fulfillmentId: fulfillment.id,
    quantity: 1,
    restorations: [{ kind: "STOCK_RESERVATION", sourceId: s.reservation.id, quantity: 1 }],
    reason: "인도하지 않은 1권을 인도로 잘못 기록",
    evidence: "진열대에서 실물 1권 확인",
    physicalReturnConfirmed: true,
    actorRole: "OWNER",
    correctedBy: "점주",
    correctedAt: "2026-03-04T06:55:00.000Z",
    idempotencyKey: `fco-${++seq}`,
    ...extra,
  });
  const netDelivered = () =>
    deps.fulfillments
      .list("tenant-a", s.orderD.id)
      .reduce((sum, f) => sum + f.quantity, 0);
  const level = () => {
    const ledger = readReservationLedger(deps, "tenant-a", "book-1");
    return stockLevel(
      deps.stockMovements.list("tenant-a", "book-1"),
      ledger.reservations,
      ledger.releases,
      ledger.deliveries,
    );
  };
  return { ...s, deps, fulfillment, fulfillmentCorrections, correctRequest, netDelivered, level };
}

describe("correctFulfillment: 수령 오기록 정정 역거래 (ST-F02, D21, BR-F01~03)", () => {
  it("Owner가 실물 복귀를 확인한 오기록을 정정하면 원 수령은 보존되고 순 수령량이 줄며 예약과 보유 재고가 복원된다", () => {
    const { deps, fulfillment, correctRequest, netDelivered, level, orderD } = correctionScene();
    const before = level();

    const correction = correctFulfillment(deps, correctRequest());

    expect(correction).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: orderD.id,
      fulfillmentId: fulfillment.id,
      reversalFulfillmentId: expect.stringMatching(UUID_RE),
      quantity: 1,
      restorations: [{ kind: "STOCK_RESERVATION", sourceId: expect.any(String), quantity: 1 }],
      reason: "인도하지 않은 1권을 인도로 잘못 기록",
      evidence: "진열대에서 실물 1권 확인",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:55:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    const rows = deps.fulfillments.list("tenant-a", orderD.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(fulfillment); // 원 수령은 그대로
    expect(netDelivered()).toBe(1);
    const after = level();
    expect(after.onHand).toBe(before.onHand + 1);
    expect(after.reserved).toBe(before.reserved + 1);
    expect(after.available).toBe(before.available);
  });

  it("Staff는 정정할 수 없고(FORBIDDEN 403), 형식 오류는 VALIDATION_ERROR 400, 실물 복귀 미확인은 BUSINESS_INVARIANT 422이며 어느 경우도 아무것도 기록되지 않는다", () => {
    const { deps, correctRequest, netDelivered, level, orderD, fulfillmentCorrections } = correctionScene();
    const before = level();
    const codeOf = (extra: Parameters<typeof correctRequest>[0]) => {
      try {
        correctFulfillment(deps, correctRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ actorRole: "STAFF" })).toBe("FORBIDDEN");
    for (const bad of [
      { quantity: 0 },
      { quantity: 1.5 },
      { reason: "" },
      { evidence: " " },
      { correctedBy: "" },
      { correctedAt: "2999-01-01T00:00:00.000Z" },
      { restorations: [] },
    ]) {
      expect(codeOf(bad)).toBe("VALIDATION_ERROR");
    }
    expect(codeOf({ physicalReturnConfirmed: false })).toBe("BUSINESS_INVARIANT");
    expect(codeOf({ fulfillmentId: "no-such" })).toBe("NOT_FOUND");
    expect(fulfillmentCorrections).toEqual([]);
    expect(deps.fulfillments.list("tenant-a", orderD.id)).toHaveLength(1);
    expect(netDelivered()).toBe(2);
    expect(level()).toEqual(before);
  });

  it("복원 수량 합계가 정정 수량과 다르거나, 원 수령에 없던 출처이거나, 누적 정정이 원 수령량·출처별 인도량을 넘으면 BUSINESS_INVARIANT 422이고 기록되지 않는다", () => {
    const { deps, correctRequest, netDelivered, level, reservation, fulfillmentCorrections } = correctionScene();
    const codeOf = (extra: Parameters<typeof correctRequest>[0]) => {
      try {
        correctFulfillment(deps, correctRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };
    const source = (quantity: number, sourceId = reservation.id) => ({
      kind: "STOCK_RESERVATION" as const,
      sourceId,
      quantity,
    });

    expect(codeOf({ quantity: 2, restorations: [source(1)] })).toBe("BUSINESS_INVARIANT"); // 합계 불일치
    expect(codeOf({ quantity: 1, restorations: [source(1, "other-reservation")] })).toBe("BUSINESS_INVARIANT");
    expect(codeOf({ quantity: 3, restorations: [source(3)] })).toBe("BUSINESS_INVARIANT"); // 원 수령 2 초과
    expect(fulfillmentCorrections).toEqual([]);
    expect(netDelivered()).toBe(2);

    expect(codeOf({ quantity: 1 })).toBeUndefined(); // 누적 1
    expect(codeOf({ quantity: 2, restorations: [source(2)] })).toBe("BUSINESS_INVARIANT"); // 누적 3 > 2
    expect(codeOf({ quantity: 1 })).toBeUndefined(); // 누적 2 = 원 수령
    expect(codeOf({ quantity: 1 })).toBe("BUSINESS_INVARIANT"); // 누적 3 > 2
    expect(netDelivered()).toBe(0);
    expect(level().reserved).toBe(2);
  });

  it("입고 배분 출처로 인도한 수령도 정정할 수 있고, 배분의 순 인도량이 줄어 잔량이 복원되며 재고 원장은 건드리지 않는다", () => {
    const base = fulfillmentScene();
    const orderB = base.orders[1]!; // 3권 배분 (단가 15,000원)
    base.pay(orderB.id, "45000");
    const lineId = orderB.lines[0]!.lineId;
    const fulfillment = postFulfillment(
      base.deps,
      base.fulfillRequest({
        orderId: orderB.id,
        orderLineId: lineId,
        sources: [{ kind: "RECEIPT_ALLOCATION", sourceId: base.allocation.id, quantity: 2 }],
      }),
    );
    const saved: FulfillmentCorrection[] = [];
    const deps = {
      ...base.deps,
      fulfillmentCorrections: { list: () => saved, save: (c: FulfillmentCorrection) => void saved.push(c) },
    };
    const movementsBefore = deps.stockMovements.list("tenant-a", "book-1").length;

    correctFulfillment(deps, {
      tenantId: "tenant-a",
      orderId: orderB.id,
      fulfillmentId: fulfillment.id,
      quantity: 1,
      restorations: [{ kind: "RECEIPT_ALLOCATION", sourceId: base.allocation.id, quantity: 1 }],
      reason: "인도하지 않은 1권을 인도로 잘못 기록",
      evidence: "배분 보관함에서 실물 1권 확인",
      physicalReturnConfirmed: true,
      actorRole: "OWNER",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:55:00.000Z",
      idempotencyKey: "fco-alloc",
    });

    expect(
      deps.allocationDeliveries.list("tenant-a", base.allocation.id).reduce((sum, d) => sum + d.quantity, 0),
    ).toBe(1);
    expect(deps.allocationDeliveries.list("tenant-a", base.allocation.id)).toHaveLength(2); // 원 인도 보존
    expect(deps.fulfillments.list("tenant-a", orderB.id).reduce((sum, f) => sum + f.quantity, 0)).toBe(1);
    expect(deps.stockMovements.list("tenant-a", "book-1")).toHaveLength(movementsBefore);
  });
});

describe("종결 후 수령 정정과 주문 재개 (ST-F02 → ST-O10, D21, BR-O07)", () => {
  it("종결된 주문의 수령을 Owner가 정정해 미인도가 생기면 서버가 주문을 재개하고 UNDELIVERED 사유를 기록한다", () => {
    const s = reopeningScene();
    const saved: FulfillmentCorrection[] = [];
    const deps = {
      ...s.deps,
      fulfillmentCorrections: {
        list: () => saved,
        save: (c: FulfillmentCorrection) => void saved.push(c),
      },
    };
    const closed = deps.orders.get("tenant-a", s.orderD.id)!;
    const original = deps.fulfillments.list("tenant-a", s.orderD.id)[0]!;

    const correction = correctFulfillment(deps, {
      tenantId: "tenant-a",
      orderId: s.orderD.id,
      fulfillmentId: original.id,
      quantity: 1,
      restorations: [{ kind: "STOCK_RESERVATION", sourceId: s.reservation.id, quantity: 1 }],
      reason: "인도하지 않은 1권을 인도로 잘못 기록",
      evidence: "진열대에서 실물 1권 확인",
      physicalReturnConfirmed: true,
      actorRole: "OWNER",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:59:30.000Z",
      idempotencyKey: "fco-reopen",
    });
    const reopening = executeOrderReopening(
      deps,
      s.reopenRequest(correction.id, { trigger: { kind: "FULFILLMENT_CORRECTION", id: correction.id } }),
    );

    expect(reopening.trigger).toEqual({ kind: "FULFILLMENT_CORRECTION", id: correction.id });
    expect(reopening.blockers).toEqual(["UNDELIVERED"]);
    const reopened = deps.orders.get("tenant-a", s.orderD.id)!;
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.version).toBe(closed.version + 1);
  });
});
