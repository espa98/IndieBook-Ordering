import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { applyOrderCancellation } from "../../src/order/applyOrderCancellation";
import { orderCancellationStatus } from "../../src/order/orderCancellationState";
import { decideOrderCancellation } from "../../src/order/decideOrderCancellation";
import { requestOrderCancellation } from "../../src/order/requestOrderCancellation";
import { applyScene, cancellationRequestScene, decisionScene } from "../helpers/cancellationFixtures";

describe("applyOrderCancellation: 승인된 취소 요청 적용 (ST-O05, BR-O05/O06/O07)", () => {
  it("적용하면 주문 품목 수량·합계가 줄고 version이 오르며, 줄어든 수량보다 많이 확보된 예약은 해제되고 요청은 APPLIED가 된다", () => {
    const { deps, applyRequest, cancellationRequest, orderD, reservation } = applyScene(); // 2권 주문, 예약 2, 1권 취소 승인
    const lineId = orderD.lines[0]!.lineId;

    applyOrderCancellation(deps, applyRequest());

    const order = deps.orders.get("tenant-a", orderD.id)!;
    expect(order.lines.find((l) => l.lineId === lineId)).toMatchObject({ quantity: 1, unitPriceKrw: "15000" });
    expect(order).toMatchObject({ status: "CONFIRMED", totalKrw: "15000", version: orderD.version + 1 });
    expect(
      deps.stockReservationReleases.list("tenant-a", reservation.id).map((r) => r.quantity),
    ).toEqual([1]); // 확보 2 > 필요 1 → 1권 해제
    expect(
      orderCancellationStatus(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)),
    ).toBe("APPLIED");
  });

  it("입고 배분으로 확보된 수량이 줄어든 필요량을 넘으면 초과분이 처분 대기(취소 처분)로 직접 귀속되고 미배분으로 돌아오지 않는다 (BR-Q21)", () => {
    const s = cancellationRequestScene();
    const orderB = s.orders[1]!; // 3권, 입고 배분 3
    const request = requestOrderCancellation(s.deps, s.cancelOrderRequest({
      orderId: orderB.id,
      orderLineId: orderB.lines[0]!.lineId,
      quantity: 2,
      expectedVersion: orderB.version,
      idempotencyKey: "ocr-b",
    }));
    decideOrderCancellation(s.deps, {
      tenantId: "tenant-a",
      requestId: request.id,
      decision: "APPROVED",
      actorRole: "OWNER",
      decidedBy: "점주",
      decidedAt: "2026-03-04T06:40:00.000Z",
      idempotencyKey: "ocd-b",
    });

    applyOrderCancellation(s.deps, {
      tenantId: "tenant-a",
      requestId: request.id,
      actorRole: "OWNER",
      appliedBy: "점주",
      appliedAt: "2026-03-04T06:45:00.000Z",
      idempotencyKey: "oca-b",
    });

    expect(s.deps.orders.get("tenant-a", orderB.id)).toMatchObject({ totalKrw: "15000" });
    const cancellations = s.deps.allocationCancellations.list("tenant-a", s.allocation.id);
    expect(cancellations.map((c) => c.quantity)).toEqual([2]);
    expect(cancellations[0]).toMatchObject({ orderId: orderB.id, receiptId: s.allocation.receiptId });
  });

  it("이미 확인된 결제가 줄어든 주문 총액을 넘으면 같은 적용에서 과수납분의 환급 필요 업무가 열리고, 결제 전이면 열리지 않는다", () => {
    const paid = applyScene();
    paid.pay(paid.orderD.id, "30000"); // 총액 30,000원 전액 결제 확인
    applyOrderCancellation(paid.deps, paid.applyRequest()); // 1권 취소 → 총액 15,000원

    const tasks = paid.deps.refundTasks.list("tenant-a", paid.orderD.id);
    expect(tasks.map((t) => t.requiredKrw)).toEqual(["15000"]);

    const unpaid = applyScene();
    applyOrderCancellation(unpaid.deps, unpaid.applyRequest());
    expect(unpaid.deps.refundTasks.list("tenant-a", unpaid.orderD.id)).toEqual([]);
  });

  it("STAFF는 적용할 수 없고(FORBIDDEN 403), 승인되지 않았거나 이미 적용된 요청은 적용할 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const owner = applyScene();
    let forbidden: unknown;
    try {
      applyOrderCancellation(owner.deps, owner.applyRequest({ actorRole: "STAFF" }));
    } catch (error) {
      forbidden = error;
    }
    expect((forbidden as AppError).code).toBe("FORBIDDEN");

    const unapproved = decisionScene(); // REQUESTED 상태
    let notApproved: unknown;
    try {
      applyOrderCancellation(unapproved.deps, {
        tenantId: "tenant-a",
        requestId: unapproved.cancellationRequest.id,
        actorRole: "OWNER",
        appliedBy: "점주",
        appliedAt: "2026-03-04T06:45:00.000Z",
        idempotencyKey: "oca-x",
      });
    } catch (error) {
      notApproved = error;
    }
    expect((notApproved as AppError).code).toBe("BUSINESS_INVARIANT");

    applyOrderCancellation(owner.deps, owner.applyRequest());
    let again: unknown;
    try {
      applyOrderCancellation(owner.deps, owner.applyRequest());
    } catch (error) {
      again = error;
    }
    expect((again as AppError).code).toBe("BUSINESS_INVARIANT"); // 한 번만 적용
    expect(owner.deps.orders.get("tenant-a", owner.orderD.id)).toMatchObject({ totalKrw: "15000" });
  });

  it("승인 뒤 적용 전에 주문 version이 바뀌었으면 적용하지 않고 STALE로 기록하며 주문·예약은 그대로다 (승인 후 대상 변경)", () => {
    const { deps, applyRequest, cancellationRequest, orderD, reservation } = applyScene();
    const order = deps.orders.get("tenant-a", orderD.id)!;
    deps.orders.save({ ...order, version: order.version + 1 }); // 다른 거래가 주문을 변경

    const decision = applyOrderCancellation(deps, applyRequest());

    expect(decision.kind).toBe("STALE");
    expect(
      orderCancellationStatus(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)),
    ).toBe("STALE");
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual({ ...order, version: order.version + 1 });
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toEqual([]);
  });

  it("적용자·appliedAt이 잘못이면 VALIDATION_ERROR 400, 없는 요청·다른 테넌트는 NOT_FOUND 404이고 아무것도 바뀌지 않는다", () => {
    const { deps, applyRequest, orderD, reservation, cancellationRequest } = applyScene();
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));
    const codeOf = (request: ReturnType<typeof applyRequest>) => {
      try {
        applyOrderCancellation(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(applyRequest({ appliedBy: " " }))).toBe("VALIDATION_ERROR");
    expect(codeOf(applyRequest({ appliedAt: "2026-03-04" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(applyRequest({ appliedAt: "2999-03-04T08:00:00.000Z" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(applyRequest({ requestId: "no-such-request" }))).toBe("NOT_FOUND");
    expect(codeOf(applyRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore);
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toEqual([]);
    expect(
      orderCancellationStatus(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)),
    ).toBe("APPROVED");
  });

  it("같은 멱등 키로 재호출하면 같은 결과를 돌려주고 주문 수량을 두 번 줄이지 않는다", () => {
    const { deps, applyRequest, orderD, reservation } = applyScene();

    const first = applyOrderCancellation(deps, applyRequest({ idempotencyKey: "k" }));
    const replay = applyOrderCancellation(deps, applyRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    const order = deps.orders.get("tenant-a", orderD.id)!;
    expect(order.lines[0]!.quantity).toBe(1);
    expect(order.version).toBe(orderD.version + 1);
    expect(deps.stockReservationReleases.list("tenant-a", reservation.id)).toHaveLength(1);
  });

  it("모든 품목의 유효 수량이 0이 되도록 적용하면 전량 취소로 주문에 cancelledAt이 기록되고(CANCELLING), 일부만 취소하면 기록되지 않는다 (BR-O07)", () => {
    const partial = applyScene(); // 2권 주문에서 1권만 취소
    applyOrderCancellation(partial.deps, partial.applyRequest());
    expect(partial.deps.orders.get("tenant-a", partial.orderD.id)!.cancelledAt).toBeUndefined();

    const full = cancellationRequestScene();
    const request = requestOrderCancellation(full.deps, full.cancelOrderRequest({ quantity: 2, idempotencyKey: "ocr-full" }));
    decideOrderCancellation(full.deps, {
      tenantId: "tenant-a",
      requestId: request.id,
      decision: "APPROVED",
      actorRole: "OWNER",
      decidedBy: "점주",
      decidedAt: "2026-03-04T06:40:00.000Z",
      idempotencyKey: "ocd-full",
    });

    applyOrderCancellation(full.deps, {
      tenantId: "tenant-a",
      requestId: request.id,
      actorRole: "OWNER",
      appliedBy: "점주",
      appliedAt: "2026-03-04T06:45:00.000Z",
      idempotencyKey: "oca-full",
    });

    const order = full.deps.orders.get("tenant-a", full.orderD.id)!;
    expect(order.lines[0]!.quantity).toBe(0);
    expect(order).toMatchObject({ totalKrw: "0", cancelledAt: "2026-03-04T06:45:00.000Z" });
    expect(order.closedAt).toBeUndefined(); // 취소 종결은 후속 업무가 끝난 뒤 서버가 한다
  });
});
