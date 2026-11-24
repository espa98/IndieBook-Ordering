import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { decideOrderCancellation } from "../../src/order/decideOrderCancellation";
import { orderCancellationStatus } from "../../src/order/orderCancellationState";
import { decisionScene } from "../helpers/cancellationFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("decideOrderCancellation: 취소 요청 승인·거절·철회 (BR-O05, D27, DEC-09)", () => {
  it("Owner가 승인해도 주문 수량·버전은 그대로이고(승인 자체는 수량 변경이 아니다) 요청 상태가 APPROVED가 되며 잠금은 유지된다", () => {
    const { deps, decideRequest, cancellationRequest, orderD } = decisionScene();
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));

    const decision = decideOrderCancellation(deps, decideRequest({ decision: "APPROVED" }));

    expect(decision).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      requestId: cancellationRequest.id,
      kind: "APPROVED",
      decidedBy: "점주",
      decidedAt: "2026-03-04T06:40:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(
      orderCancellationStatus(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)),
    ).toBe("APPROVED");
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore);
  });

  it("Owner의 거절·Staff의 철회는 요청을 종결하고 D27 잠금을 풀어 해당 수량을 다시 인도할 수 있다", () => {
    for (const [decision, actorRole, decidedBy] of [
      ["REJECTED", "OWNER", "점주"],
      ["WITHDRAWN", "STAFF", "김직원"],
    ] as const) {
      const { deps, decideRequest, cancellationRequest, pay, orderD, reservation, fulfillRequest } = decisionScene();
      pay(orderD.id, "30000");
      const sources = [{ kind: "STOCK_RESERVATION" as const, sourceId: reservation.id, quantity: 2 }];
      expect(() => postFulfillment(deps, fulfillRequest({ sources }))).toThrow(AppError); // 1권 잠김

      decideOrderCancellation(deps, decideRequest({ decision, actorRole, decidedBy }));

      expect(
        orderCancellationStatus(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)),
      ).toBe(decision);
      expect(postFulfillment(deps, fulfillRequest({ sources })).quantity).toBe(2); // 잠금이 풀려 2권 모두 인도
    }
  });

  it("STAFF는 승인·거절할 수 없고(FORBIDDEN 403) 아무것도 기록되지 않는다", () => {
    const { deps, decideRequest, cancellationRequest } = decisionScene();

    for (const decision of ["APPROVED", "REJECTED"] as const) {
      let thrown: unknown;
      try {
        decideOrderCancellation(deps, decideRequest({ decision, actorRole: "STAFF" }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("FORBIDDEN");
    }
    expect(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)).toEqual([]);
  });

  it("이미 결정된(종결·승인된) 요청은 다시 결정할 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const { deps, decideRequest, cancellationRequest } = decisionScene();
    decideOrderCancellation(deps, decideRequest({ decision: "REJECTED" }));

    for (const decision of ["APPROVED", "REJECTED", "WITHDRAWN"] as const) {
      let thrown: unknown;
      try {
        decideOrderCancellation(deps, decideRequest({ decision }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    }
    expect(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)).toHaveLength(1);
  });

  it("승인 시점에 주문 version이 요청 시점과 다르면 승인하지 않고 STALE로 기록해 잠금을 푼다 (승인 후 대상 변경은 새 요청으로 재검토)", () => {
    const { deps, decideRequest, cancellationRequest, orderD } = decisionScene();
    const order = deps.orders.get("tenant-a", orderD.id)!;
    deps.orders.save({ ...order, version: order.version + 1 }); // 다른 거래가 주문 version을 올림

    const decision = decideOrderCancellation(deps, decideRequest({ decision: "APPROVED" }));

    expect(decision.kind).toBe("STALE");
    expect(
      orderCancellationStatus(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)),
    ).toBe("STALE");
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual({ ...order, version: order.version + 1 });
  });

  it("결정 종류가 잘못이거나 결정자가 비었거나 decidedAt이 잘못·미래이면 VALIDATION_ERROR 400, 없는 요청·타 테넌트는 NOT_FOUND 404이다", () => {
    const { deps, decideRequest, cancellationRequest } = decisionScene();
    const codeOf = (request: ReturnType<typeof decideRequest>) => {
      try {
        decideOrderCancellation(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(decideRequest({ decision: "APPLIED" as never }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ decidedBy: " " }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ decidedAt: "2026-03-04" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ decidedAt: "2999-03-04T08:00:00.000Z" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(decideRequest({ requestId: "no-such-request" }))).toBe("NOT_FOUND");
    expect(codeOf(decideRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 결정을 돌려주고(이미 결정됨 오류가 아니다) 중복 기록하지 않는다", () => {
    const { deps, decideRequest, cancellationRequest } = decisionScene();

    const first = decideOrderCancellation(deps, decideRequest({ idempotencyKey: "k" }));
    const replay = decideOrderCancellation(deps, decideRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.orderCancellationDecisions.list("tenant-a", cancellationRequest.id)).toEqual([first]);
  });
});
