import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { requestOrderCancellation } from "../../src/order/requestOrderCancellation";
import { cancellationRequestScene } from "../helpers/cancellationFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("requestOrderCancellation: 주문 취소 요청 (ST-O05/O06, BR-O05/O06, D27)", () => {
  it("미인도 수량의 취소를 요청하면 요청 기록만 남고 주문 수량·상태·버전은 바뀌지 않는다", () => {
    const { deps, cancelOrderRequest, orderD, orderCancellationRequests } = cancellationRequestScene();
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));

    const request = requestOrderCancellation(deps, cancelOrderRequest({ quantity: 1 }));

    expect(request).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: orderD.id,
      orderLineId: orderD.lines[0]!.lineId,
      quantity: 1,
      reason: "고객이 1권 취소를 요청",
      baseVersion: orderD.version,
      requestedBy: "김직원",
      requestedAt: "2026-03-04T06:30:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(orderCancellationRequests.list("tenant-a", orderD.id)).toEqual([request]);
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore);
  });

  it("취소 가능량은 E-F에서 진행 중인 요청의 잠금을 뺀 값이고(2권 주문), 이미 인도한 물량은 일반 취소 대상이 아니다", () => {
    const { deps, cancelOrderRequest, orderCancellationRequests, orderD } = cancellationRequestScene();
    const request = (quantity: number) => {
      try {
        requestOrderCancellation(deps, cancelOrderRequest({ quantity }));
      } catch (error) {
        return error as AppError;
      }
    };

    expect(request(3)?.code).toBe("BUSINESS_INVARIANT"); // E=2
    expect(request(1)).toBeUndefined(); // 잠금 1
    expect(request(2)?.code).toBe("BUSINESS_INVARIANT"); // 가능량 1
    expect(request(1)).toBeUndefined(); // 잠금 2
    expect(request(1)?.code).toBe("BUSINESS_INVARIANT"); // 가능량 0
    expect(orderCancellationRequests.list("tenant-a", orderD.id)).toHaveLength(2);
  });

  it("이미 인도한 수량은 취소 요청할 수 없다 (E-F)", () => {
    const { deps, cancelOrderRequest, pay, orderD, reservation, fulfillRequest } = cancellationRequestScene();
    pay(orderD.id, "15000");
    postFulfillment(
      deps,
      fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }] }),
    ); // F=1

    let thrown: unknown;
    try {
      requestOrderCancellation(deps, cancelOrderRequest({ quantity: 2 })); // 가능량 E-F=1
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(() => requestOrderCancellation(deps, cancelOrderRequest({ quantity: 1 }))).not.toThrow();
  });

  it("수량·사유·담당자·expectedVersion·requestedAt이 잘못이면 VALIDATION_ERROR 400이다", () => {
    const { deps, cancelOrderRequest, orderD, orderCancellationRequests } = cancellationRequestScene();

    for (const bad of [
      cancelOrderRequest({ quantity: 0 }),
      cancelOrderRequest({ quantity: 1.5 }),
      cancelOrderRequest({ quantity: Number.NaN }),
      cancelOrderRequest({ reason: " " }),
      cancelOrderRequest({ requestedBy: "" }),
      cancelOrderRequest({ expectedVersion: 0 }),
      cancelOrderRequest({ requestedAt: "2026-03-04" }),
      cancelOrderRequest({ requestedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        requestOrderCancellation(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(orderCancellationRequests.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("없는 주문·품목·다른 테넌트는 NOT_FOUND 404, 요청 version이 현재와 다르면 VERSION_CONFLICT 409, 종결된 주문은 BUSINESS_INVARIANT 422이다", () => {
    const { deps, cancelOrderRequest, orderD, orderCancellationRequests } = cancellationRequestScene();
    const codeOf = (request: ReturnType<typeof cancelOrderRequest>) => {
      try {
        requestOrderCancellation(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(cancelOrderRequest({ orderId: "no-such-order" }))).toBe("NOT_FOUND");
    expect(codeOf(cancelOrderRequest({ orderLineId: "no-such-line" }))).toBe("NOT_FOUND");
    expect(codeOf(cancelOrderRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(codeOf(cancelOrderRequest({ expectedVersion: orderD.version + 1 }))).toBe("VERSION_CONFLICT");

    const current = deps.orders.get("tenant-a", orderD.id)!;
    deps.orders.save({ ...current, closedAt: "2026-03-04T06:00:00.000Z" });
    expect(codeOf(cancelOrderRequest())).toBe("BUSINESS_INVARIANT");
    expect(orderCancellationRequests.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 요청을 돌려주고(수량 한도 오류가 아니다) 중복 잠금하지 않는다", () => {
    const { deps, cancelOrderRequest, orderD, orderCancellationRequests } = cancellationRequestScene();

    const first = requestOrderCancellation(deps, cancelOrderRequest({ quantity: 2, idempotencyKey: "k" }));
    const replay = requestOrderCancellation(deps, cancelOrderRequest({ quantity: 2, idempotencyKey: "k" })); // 한도 소진 후

    expect(replay).toEqual(first);
    expect(orderCancellationRequests.list("tenant-a", orderD.id)).toEqual([first]);
  });

  it("진행 중인 취소 요청의 수량은 인도할 수 없고(D27) 요청하지 않은 수량만 인도할 수 있다", () => {
    const { deps, cancelOrderRequest, pay, orderD, reservation, fulfillRequest } = cancellationRequestScene(); // 2권 예약
    pay(orderD.id, "30000");
    requestOrderCancellation(deps, cancelOrderRequest({ quantity: 1 })); // 1권 취소 요청 중
    const post = (quantity: number) => {
      try {
        return postFulfillment(
          deps,
          fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity }] }),
        );
      } catch (error) {
        return error as AppError;
      }
    };

    expect((post(2) as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(post(1)).toMatchObject({ quantity: 1 });
    expect((post(1) as AppError).code).toBe("BUSINESS_INVARIANT"); // 남은 1권은 취소 요청 대상
  });
});
