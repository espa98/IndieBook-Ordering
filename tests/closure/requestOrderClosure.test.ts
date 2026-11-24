import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { requestOrderClosure } from "../../src/order/requestOrderClosure";
import { closureRequestScene } from "../helpers/closureFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("requestOrderClosure: Staff의 종결 요청 (ST-O07, BR-O03/O08)", () => {
  it("종결을 요청하면 요청 기록만 남고 주문 상태·버전은 바뀌지 않는다 (종결은 서버가 재계산해 별도로 실행한다)", () => {
    const { deps, closureRequest, orderD, closureRequests } = closureRequestScene();
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));

    const request = requestOrderClosure(deps, closureRequest());

    expect(request).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: orderD.id,
      expectedVersion: orderD.version,
      requestedBy: "김직원",
      requestedAt: "2026-03-04T06:58:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(closureRequests.list("tenant-a", orderD.id)).toEqual([request]);
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore);
  });

  it("expectedVersion이 1 이상 정수가 아니거나 담당자가 비었거나 requestedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, closureRequest, orderD, closureRequests } = closureRequestScene();

    for (const bad of [
      closureRequest({ expectedVersion: 0 }),
      closureRequest({ expectedVersion: 1.5 }),
      closureRequest({ expectedVersion: Number.NaN }),
      closureRequest({ requestedBy: " " }),
      closureRequest({ requestedAt: "2026-03-04" }),
      closureRequest({ requestedAt: "2026-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        requestOrderClosure(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(closureRequests.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("없는 주문·다른 테넌트의 주문은 NOT_FOUND 404, 주문 version과 다르면 VERSION_CONFLICT 409이다", () => {
    const { deps, closureRequest, orderD, closureRequests } = closureRequestScene();
    const codeOf = (request: ReturnType<typeof closureRequest>) => {
      try {
        requestOrderClosure(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(closureRequest({ orderId: "no-such-order" }))).toBe("NOT_FOUND");
    expect(codeOf(closureRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(codeOf(closureRequest({ expectedVersion: orderD.version + 1 }))).toBe("VERSION_CONFLICT");
    expect(closureRequests.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 요청을 돌려주고 중복 기록하지 않는다", () => {
    const { deps, closureRequest, orderD, closureRequests } = closureRequestScene();

    const first = requestOrderClosure(deps, closureRequest({ idempotencyKey: "k" }));
    const replay = requestOrderClosure(deps, closureRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(closureRequests.list("tenant-a", orderD.id)).toEqual([first]);
  });
});
