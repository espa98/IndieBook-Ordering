import { describe, it, expect } from "vitest";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { reserveStock } from "../../src/inventory/reserveStock";
import { recordPayment } from "../../src/payment/recordPayment";
import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { AppError } from "../../src/errors/AppError";
import { executeOrderClosure } from "../../src/order/executeOrderClosure";
import { executionScene } from "../helpers/closureFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("executeOrderClosure: 서버 내부 종결 실행 (ST-O07, BR-O03/O08, DEC-10)", () => {
  it("요청된 종결을 서버가 같은 호출에서 재계산해 충족하면 주문에 종결 시각과 version+1을 기록하고 종결 기록을 남긴다", () => {
    const { deps, executeRequest, orderD, closureRequestRecord, orderClosures } = executionScene();

    const closure = executeOrderClosure(deps, executeRequest());

    expect(closure).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: orderD.id,
      closureRequestId: closureRequestRecord.id,
      orderVersionBefore: orderD.version,
      orderVersionAfter: orderD.version + 1,
      executedBy: "SYSTEM",
      closedAt: "2026-03-04T06:59:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(orderClosures.list("tenant-a", orderD.id)).toEqual([closure]);
    expect(deps.orders.get("tenant-a", orderD.id)).toMatchObject({
      status: "CONFIRMED",
      version: orderD.version + 1,
      closedAt: "2026-03-04T06:59:00.000Z",
    });
  });

  it("요청 뒤 실행 전에 미확인 결제가 생기는 등 차단 사유가 생기면 서버 재계산에서 거부되고(BUSINESS_INVARIANT 422, 사유 포함) 주문과 기록은 그대로다", () => {
    const { deps, executeRequest, orderD, pay, orderClosures } = executionScene(); // 요청 시점엔 종결 가능
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));
    pay(orderD.id, "5000", false); // 요청 후 입력만 되고 확인되지 않은 결제

    let thrown: unknown;
    try {
      executeOrderClosure(deps, executeRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).httpStatus).toBe(422);
    expect((thrown as AppError).detail).toContain("PAYMENT_PENDING_VERIFICATION");
    expect(orderClosures.list("tenant-a", orderD.id)).toEqual([]);
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore);
  });

  it("실행 주체가 서버(SYSTEM)가 아니면 FORBIDDEN 403이고, 아무것도 기록되지 않는다 (Staff는 요청만 할 수 있다)", () => {
    const { deps, executeRequest, orderD, orderClosures } = executionScene();
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));

    for (const executedBy of ["김직원", "OWNER", ""]) {
      let thrown: unknown;
      try {
        executeOrderClosure(deps, executeRequest({ executedBy: executedBy as never }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("FORBIDDEN");
    }
    expect(orderClosures.list("tenant-a", orderD.id)).toEqual([]);
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore);
  });

  it("요청 이후 주문 version이 바뀌었으면 VERSION_CONFLICT 409(STALE)로 거부하고, 이미 종결된 주문은 다시 종결할 수 없다", () => {
    const stale = executionScene();
    const order = stale.deps.orders.get("tenant-a", stale.orderD.id)!;
    stale.deps.orders.save({ ...order, version: order.version + 1 }); // 다른 거래가 주문 version을 올림
    let conflict: unknown;
    try {
      executeOrderClosure(stale.deps, stale.executeRequest());
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(AppError);
    expect((conflict as AppError).code).toBe("VERSION_CONFLICT");
    expect(stale.orderClosures.list("tenant-a", stale.orderD.id)).toEqual([]);

    const closed = executionScene();
    executeOrderClosure(closed.deps, closed.executeRequest());
    let again: unknown;
    try {
      executeOrderClosure(closed.deps, closed.executeRequest()); // 새 멱등 키
    } catch (error) {
      again = error;
    }
    expect(again).toBeInstanceOf(AppError);
    expect((again as AppError).code).toBe("BUSINESS_INVARIANT"); // 이미 종결됨이 version 충돌보다 먼저 판정된다
    expect(closed.orderClosures.list("tenant-a", closed.orderD.id)).toHaveLength(1);
  });

  it("없는 종결 요청·다른 테넌트의 요청은 NOT_FOUND 404이고, executedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, executeRequest, orderD, orderClosures } = executionScene();
    const codeOf = (request: ReturnType<typeof executeRequest>) => {
      try {
        executeOrderClosure(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(executeRequest({ closureRequestId: "no-such-request" }))).toBe("NOT_FOUND");
    expect(codeOf(executeRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(codeOf(executeRequest({ executedAt: "2026-03-04" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(executeRequest({ executedAt: "2026-03-04T08:00:00.000Z" }))).toBe("VALIDATION_ERROR");
    expect(orderClosures.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 종결 기록을 돌려주고(이미 종결됨 오류가 아니다) 주문 version을 다시 올리지 않는다", () => {
    const { deps, executeRequest, orderD, orderClosures } = executionScene();

    const first = executeOrderClosure(deps, executeRequest({ idempotencyKey: "k" }));
    const replay = executeOrderClosure(deps, executeRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(orderClosures.list("tenant-a", orderD.id)).toEqual([first]);
    expect(deps.orders.get("tenant-a", orderD.id)!.version).toBe(orderD.version + 1);
  });

  it("종결된 주문에는 결제 입력·재고 예약·인도·조달 배정 같은 신규 거래를 추가할 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const { deps, executeRequest, orderD, w, fulfillRequest, reservation } = executionScene();
    executeOrderClosure(deps, executeRequest());
    const codeOf = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as AppError).code;
      }
    };
    const lineId = orderD.lines[0]!.lineId;

    expect(
      codeOf(() =>
        recordPayment(deps, {
          tenantId: "tenant-a",
          orderId: orderD.id,
          method: "CARD",
          amountKrw: "1000",
          externalReference: "AFTER-CLOSE",
          paidAt: "2026-03-04T06:00:00.000Z",
          recordedBy: "김직원",
          idempotencyKey: "pay-after-close",
        }),
      ),
    ).toBe("BUSINESS_INVARIANT");
    expect(
      codeOf(() =>
        reserveStock(deps, {
          tenantId: "tenant-a",
          orderId: orderD.id,
          orderLineId: lineId,
          quantity: 1,
          reservedBy: "김직원",
          reservedAt: "2026-03-04T06:40:00.000Z",
          idempotencyKey: "res-after-close",
        }),
      ),
    ).toBe("BUSINESS_INVARIANT");
    expect(
      codeOf(() =>
        postFulfillment(
          deps,
          fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }] }),
        ),
      ),
    ).toBe("BUSINESS_INVARIANT");
    expect(
      codeOf(() =>
        allocateSourcing(w.deps, {
          tenantId: "tenant-a",
          orderId: orderD.id,
          lineId,
          supplierCode: "sup-a",
          quantity: 1,
          idempotencyKey: "alloc-after-close",
        }),
      ),
    ).toBe("BUSINESS_INVARIANT");
  });
});
