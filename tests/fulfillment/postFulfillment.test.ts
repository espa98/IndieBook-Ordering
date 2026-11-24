import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { voidPayment } from "../../src/payment/voidPayment";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { fulfillmentScene } from "../helpers/fulfillmentFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("postFulfillment: 수령(인도) 등록 (ST-F01, UC-13, FUL-001/002, DEC-11)", () => {
  it("확인된 결제가 인도 대상 금액을 충족하면 수령 거래가 기록되고 출처(예약) 인도와 보유 감소가 함께 반영된다", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments, st } = fulfillmentScene();
    pay(orderD.id, "15000"); // 1권(15,000원) 확인 결제
    const movementsBefore = st.stockMovements.list("tenant-a", "book-1").length;

    const fulfillment = postFulfillment(deps, fulfillRequest());

    expect(fulfillment).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: orderD.id,
      orderLineId: orderD.lines[0]!.lineId,
      quantity: 1,
      unitPriceKrw: "15000",
      amountKrw: "15000",
      sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }],
      receivedBy: "김직원",
      receivedAt: "2026-03-04T06:50:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(fulfillments.list("tenant-a", orderD.id)).toEqual([fulfillment]);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toHaveLength(1);
    expect(st.stockMovements.list("tenant-a", "book-1")).toHaveLength(movementsBefore + 1);
  });

  it("인도 대상 금액에 못 미치는 확인 결제(없음·미확인·무효·부족)면 BUSINESS_INVARIANT 422로 거부하고 어떤 기록도 남기지 않는다", () => {
    const scene = fulfillmentScene();
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments, st } = scene;
    const movementCount = () => st.stockMovements.list("tenant-a", "book-1").length;
    const before = movementCount();
    const attempt = () => {
      try {
        postFulfillment(deps, fulfillRequest());
      } catch (error) {
        return error;
      }
    };
    const expectRejected = () => {
      const thrown = attempt();
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((thrown as AppError).httpStatus).toBe(422);
      expect(fulfillments.list("tenant-a", orderD.id)).toEqual([]);
      expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([]);
      expect(movementCount()).toBe(before);
    };

    expectRejected(); // 결제 없음
    const unconfirmed = pay(orderD.id, "15000", false);
    expectRejected(); // 입력만 되고 확인되지 않음
    voidPayment(deps, {
      tenantId: "tenant-a",
      paymentId: unconfirmed.id,
      reason: "오입력",
      voidedBy: "김직원",
      voidedAt: "2026-03-04T06:40:00.000Z",
      idempotencyKey: "void-u",
    });
    pay(orderD.id, "14999"); // 확인됐지만 1권(15,000원)에 1원 부족
    expectRejected();
  });

  it("부분 인도: 확인된 결제액만큼만 누적 인도되고, 결제가 추가 확인되면 나머지를 인도할 수 있으며 예약 수량(2)을 넘는 인도는 거부된다", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments } = fulfillmentScene();
    const post = () => {
      try {
        return postFulfillment(deps, fulfillRequest());
      } catch (error) {
        return error as Error;
      }
    };

    pay(orderD.id, "15000"); // 1권분
    expect(post()).toMatchObject({ quantity: 1, amountKrw: "15000" });
    expect(post()).toBeInstanceOf(AppError); // 누적 30,000원 > 확인 15,000원

    pay(orderD.id, "15000"); // 추가 확인
    expect(post()).toMatchObject({ quantity: 1 }); // 예약 2권 소진
    pay(orderD.id, "15000"); // 결제는 충분하지만
    expect(post()).toBeInstanceOf(AppError); // 확보(예약)된 수량이 없다

    expect(fulfillments.list("tenant-a", orderD.id).map((f) => f.quantity)).toEqual([1, 1]);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toHaveLength(2);
  });

  it("출처 중 하나라도 잔량을 넘으면 앞선 출처의 인도도 반영되지 않는다(원자 처리)", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments, st } = fulfillmentScene();
    pay(orderD.id, "45000"); // 결제는 충분
    const before = st.stockMovements.list("tenant-a", "book-1").length;

    let thrown: unknown;
    try {
      postFulfillment(
        deps,
        fulfillRequest({
          sources: [
            { kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 },
            { kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 2 }, // 합계 3 > 예약 2
          ],
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(fulfillments.list("tenant-a", orderD.id)).toEqual([]);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([]);
    expect(st.stockMovements.list("tenant-a", "book-1")).toHaveLength(before);
  });

  it("출처가 비었거나 출처의 종류·수량이 잘못이거나 담당자가 비었거나 receivedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments } = fulfillmentScene();
    pay(orderD.id, "30000");
    const source = { kind: "STOCK_RESERVATION" as const, sourceId: reservation.id, quantity: 1 };

    for (const bad of [
      fulfillRequest({ sources: [] }),
      fulfillRequest({ sources: [{ ...source, quantity: 0 }] }),
      fulfillRequest({ sources: [{ ...source, quantity: 1.5 }] }),
      fulfillRequest({ sources: [{ ...source, quantity: Number.NaN }] }),
      fulfillRequest({ sources: [{ ...source, kind: "WAREHOUSE" as never }] }),
      fulfillRequest({ sources: [{ ...source, sourceId: " " }] }),
      fulfillRequest({ receivedBy: " " }),
      fulfillRequest({ receivedAt: "2026-03-04" }),
      fulfillRequest({ receivedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        postFulfillment(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(fulfillments.list("tenant-a", orderD.id)).toEqual([]);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([]);
  });

  it("없는 주문·품목·다른 테넌트는 NOT_FOUND 404이고, 다른 주문의 예약 물량을 출처로 쓰면 BUSINESS_INVARIANT 422이다", () => {
    const { deps, orderD, reservation, orders, pay, fulfillRequest, fulfillments } = fulfillmentScene();
    pay(orderD.id, "30000");
    pay(orders[0]!.id, "30000"); // 주문 A도 결제는 충분하게 해, 거부 원인이 출처 불일치뿐이게 한다
    const outcome = (request: ReturnType<typeof fulfillRequest>) => {
      try {
        postFulfillment(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(outcome(fulfillRequest({ orderId: "no-such-order" }))).toBe("NOT_FOUND");
    expect(outcome(fulfillRequest({ orderLineId: "no-such-line" }))).toBe("NOT_FOUND");
    expect(outcome(fulfillRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    // 주문 A의 품목으로 주문 D의 예약 물량을 가져가면 안 된다
    expect(
      outcome(
        fulfillRequest({
          orderId: orders[0]!.id,
          orderLineId: orders[0]!.lines[0]!.lineId,
        }),
      ),
    ).toBe("BUSINESS_INVARIANT");
    expect(fulfillments.list("tenant-a", orderD.id)).toEqual([]);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toEqual([]);
  });

  it("입고 배분 출처로도 인도할 수 있고(출처별로 소진), 다른 주문에 배분된 물량을 가져가면 BUSINESS_INVARIANT 422이다", () => {
    const { deps, orders, allocation, pay, fulfillRequest, fulfillments } = fulfillmentScene();
    const orderB = orders[1]!; // 3권 배분 (단가 15,000원)
    pay(orderB.id, "45000");
    pay(orders[0]!.id, "30000");
    const fromAllocation = (orderId: string, orderLineId: string, quantity: number) =>
      fulfillRequest({
        orderId,
        orderLineId,
        sources: [{ kind: "RECEIPT_ALLOCATION", sourceId: allocation.id, quantity }],
      });

    const fulfillment = postFulfillment(
      deps,
      fromAllocation(orderB.id, orderB.lines[0]!.lineId, 2),
    );

    expect(fulfillment).toMatchObject({
      orderId: orderB.id,
      quantity: 2,
      amountKrw: "30000",
      sources: [{ kind: "RECEIPT_ALLOCATION", sourceId: allocation.id, quantity: 2 }],
    });
    expect(deps.allocationDeliveries.list("tenant-a", allocation.id).map((d) => d.quantity)).toEqual([2]);

    let thrown: unknown;
    try {
      postFulfillment(deps, fromAllocation(orders[0]!.id, orders[0]!.lines[0]!.lineId, 1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(fulfillments.list("tenant-a", orders[0]!.id)).toEqual([]);
    expect(deps.allocationDeliveries.list("tenant-a", allocation.id)).toHaveLength(1);
  });

  it("취소 요청 대상으로 잠긴 수량은 인도할 수 없고 잠기지 않은 수량만 인도할 수 있다 (D27)", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments, orderCancelLocks } =
      fulfillmentScene(); // 주문 D 2권, 예약 2
    pay(orderD.id, "30000");
    orderCancelLocks.lock("tenant-a", orderD.id, orderD.lines[0]!.lineId, 1); // 1권 취소 요청 중
    const post = (quantity: number) => {
      try {
        return postFulfillment(
          deps,
          fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity }] }),
        );
      } catch (error) {
        return error as Error;
      }
    };

    const tooMany = post(2);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(post(1)).toMatchObject({ quantity: 1 });
    expect(post(1)).toBeInstanceOf(AppError); // 남은 1권은 잠김
    expect(fulfillments.list("tenant-a", orderD.id)).toHaveLength(1);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toHaveLength(1);
  });

  it("같은 멱등 키로 재호출하면 같은 수령 거래를 돌려주고 출처를 중복 인도하지 않는다", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments, st } = fulfillmentScene();
    pay(orderD.id, "15000"); // 1권분만 결제: 새 요청이면 재인도는 결제 부족으로 거부될 상황
    const before = st.stockMovements.list("tenant-a", "book-1").length;

    const first = postFulfillment(deps, fulfillRequest({ idempotencyKey: "k" }));
    const replay = postFulfillment(deps, fulfillRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(fulfillments.list("tenant-a", orderD.id)).toEqual([first]);
    expect(deps.stockReservationDeliveries.list("tenant-a", reservation.id)).toHaveLength(1);
    expect(st.stockMovements.list("tenant-a", "book-1")).toHaveLength(before + 1);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments } = fulfillmentScene();
    pay(orderD.id, "30000");
    postFulfillment(deps, fulfillRequest({ idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      postFulfillment(
        deps,
        fulfillRequest({
          idempotencyKey: "k",
          sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 2 }],
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(fulfillments.list("tenant-a", orderD.id)).toHaveLength(1);
  });

  it("남은 1권을 두 요청(다른 멱등 키)이 다투면 한 건만 성공한다 (순차 경쟁 — 진짜 동시 실행은 격리 DB 없이 검증 불가)", () => {
    const { deps, orderD, reservation, pay, fulfillRequest, fulfillments } = fulfillmentScene();
    pay(orderD.id, "30000");
    postFulfillment(
      deps,
      fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }] }),
    ); // 남은 1권
    const attempt = () => {
      try {
        postFulfillment(deps, fulfillRequest());
      } catch (error) {
        return error;
      }
    };

    const results = [attempt(), attempt()];

    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(results.find((r) => r !== undefined)).toBeInstanceOf(AppError);
    expect(fulfillments.list("tenant-a", orderD.id).map((f) => f.quantity)).toEqual([1, 1]);
  });
});
