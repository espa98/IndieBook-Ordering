import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { executeOrderClosure } from "../../src/order/executeOrderClosure";
import { requestOrderClosure } from "../../src/order/requestOrderClosure";
import {
  createInMemoryOrderClosureRepository,
  createInMemoryOrderClosureRequestRepository,
} from "../helpers/closureFixtures";
import { fullyCancelledScene } from "../helpers/cancellationFixtures";

/** 전량 취소(CANCELLING)된 주문 D에 종결 요청·실행 저장소를 붙인 세계 */
function cancelledClosureScene(options: { paidKrw?: string } = {}) {
  const s = fullyCancelledScene();
  if (options.paidKrw) s.pay(s.orderD.id, options.paidKrw); // 취소 전에 결제가 확인된 주문
  s.applyFullCancellation();
  const closureRequests = createInMemoryOrderClosureRequestRepository();
  const orderClosures = createInMemoryOrderClosureRepository();
  const deps = { ...s.deps, closureRequests, orderClosures };
  const order = deps.orders.get("tenant-a", s.orderD.id)!;
  const request = requestOrderClosure(deps, {
    tenantId: "tenant-a",
    orderId: s.orderD.id,
    expectedVersion: order.version,
    requestedBy: "김직원",
    requestedAt: "2026-03-04T06:58:00.000Z",
    idempotencyKey: "clr-cancelled",
  });
  const execute = (idempotencyKey = "clx-cancelled") =>
    executeOrderClosure(deps, {
      tenantId: "tenant-a",
      closureRequestId: request.id,
      executedBy: "SYSTEM",
      executedAt: "2026-03-04T06:59:00.000Z",
      idempotencyKey,
    });
  return { ...s, deps, orderClosures, execute };
}

describe("취소 종결 (ST-O08, BR-O07)", () => {
  it("전량 취소되고 미해결 업무가 없는 주문을 서버가 종결하면 종결 기록의 outcome이 CANCELLED이고 주문에 종결 시각이 기록된다", () => {
    const { deps, orderD, orderClosures, execute } = cancelledClosureScene();

    const closure = execute();

    expect(closure.outcome).toBe("CANCELLED");
    expect(orderClosures.list("tenant-a", orderD.id)).toEqual([closure]);
    expect(deps.orders.get("tenant-a", orderD.id)).toMatchObject({
      closedAt: "2026-03-04T06:59:00.000Z",
    });
  });

  it("결제가 확인된 채 전량 취소되어 환급이 남아 있으면 종결 실행이 거부되고(BUSINESS_INVARIANT 422, 사유 포함) 종결 기록이 남지 않는다", () => {
    const { deps, orderD, orderClosures, execute } = cancelledClosureScene({ paidKrw: "30000" });
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));

    let thrown: unknown;
    try {
      execute();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).detail).toMatch(/REFUND_(REQUIRED|OPEN)/);
    expect(orderClosures.list("tenant-a", orderD.id)).toEqual([]);
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore);
  });
});
