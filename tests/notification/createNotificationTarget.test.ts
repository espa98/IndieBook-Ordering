import { describe, it, expect } from "vitest";
import { reserveStock } from "../../src/inventory/reserveStock";
import { AppError } from "../../src/errors/AppError";
import { createNotificationTarget } from "../../src/notification/createNotificationTarget";
import { notificationScene } from "../helpers/notificationFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createNotificationTarget: 확보 안내 대상 생성 (ST-M01, UC-12, DEC-05, BR-M01)", () => {
  it("주문이 전부 확보되면 현재 확보량 스냅샷을 가진 전체 확보 안내 대상이 만들어진다 (기본값 FULL)", () => {
    const { deps, orderD, targetRequest, notificationTargets } = notificationScene(); // 주문 D: 2권 중 2권 예약

    const target = createNotificationTarget(deps, targetRequest(orderD.id));

    expect(target).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: orderD.id,
      mode: "FULL",
      lines: [
        { orderLineId: orderD.lines[0]!.lineId, orderedQuantity: 2, receivedQuantity: 0, securedQuantity: 2 },
      ],
      securedTotal: 2,
      createdBy: "김직원",
      createdAt: "2026-03-04T06:55:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(notificationTargets.list("tenant-a", orderD.id)).toEqual([target]);
  });

  it("일부만 확보된 주문은 기본(전체 확보) 안내가 거부되고, 직원이 부분 확보 안내를 명시 선택하면 확보량 스냅샷으로 만들어진다", () => {
    const { deps, orderE, orders, targetRequest, notificationTargets } = notificationScene(); // 주문 E: 3권 중 1권 예약, 주문 A: 확보 0
    const codeOf = (orderId: string, mode?: "FULL" | "PARTIAL") => {
      try {
        createNotificationTarget(deps, targetRequest(orderId, mode ? { mode } : {}));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(orderE.id)).toBe("BUSINESS_INVARIANT"); // 기본 FULL: 3권 중 1권뿐
    expect(codeOf(orderE.id, "FULL")).toBe("BUSINESS_INVARIANT");
    expect(notificationTargets.list("tenant-a", orderE.id)).toEqual([]);

    const partial = createNotificationTarget(deps, targetRequest(orderE.id, { mode: "PARTIAL" }));
    expect(partial).toMatchObject({ mode: "PARTIAL", securedTotal: 1 });
    expect(partial.lines).toEqual([
      { orderLineId: orderE.lines[0]!.lineId, orderedQuantity: 3, receivedQuantity: 0, securedQuantity: 1 },
    ]);

    // 확보된 수량이 0이면 부분 안내도 만들 수 없다
    const orderA = orders[0]!; // 조달 중(확보 0)
    expect(codeOf(orderA.id, "PARTIAL")).toBe("BUSINESS_INVARIANT");
    expect(notificationTargets.list("tenant-a", orderA.id)).toEqual([]);
  });

  it("같은 확보 스냅샷에 대한 안내 대상이 이미 있으면 중복 생성할 수 없고(BUSINESS_INVARIANT 422), 확보량이 바뀌면 새 대상을 만들 수 있다", () => {
    const { deps, orderE, targetRequest, notificationTargets } = notificationScene(); // 주문 E: 1권 확보
    createNotificationTarget(deps, targetRequest(orderE.id, { mode: "PARTIAL" }));

    let thrown: unknown;
    try {
      createNotificationTarget(deps, targetRequest(orderE.id, { mode: "PARTIAL" })); // 다른 멱등 키, 같은 확보량
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(notificationTargets.list("tenant-a", orderE.id)).toHaveLength(1);

    // 확보량이 2권으로 늘면 이전 안내는 보존되고 새 대상이 가능하다
    reserveStock(deps, {
      tenantId: "tenant-a",
      orderId: orderE.id,
      orderLineId: orderE.lines[0]!.lineId,
      quantity: 1,
      reservedBy: "김직원",
      reservedAt: "2026-03-04T06:42:00.000Z",
      idempotencyKey: "res-E2",
    });
    const next = createNotificationTarget(deps, targetRequest(orderE.id, { mode: "PARTIAL" }));
    expect(next.securedTotal).toBe(2);
    expect(notificationTargets.list("tenant-a", orderE.id)).toHaveLength(2);
  });

  it("모드가 잘못이거나 담당자가 비었거나 createdAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, orderD, targetRequest, notificationTargets } = notificationScene();

    for (const bad of [
      targetRequest(orderD.id, { mode: "HALF" as never }),
      targetRequest(orderD.id, { createdBy: " " }),
      targetRequest(orderD.id, { createdAt: "2026-03-04" }),
      targetRequest(orderD.id, { createdAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        createNotificationTarget(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(notificationTargets.list("tenant-a", orderD.id)).toEqual([]);
  });

  it("없는 주문·다른 테넌트의 주문은 NOT_FOUND 404이다", () => {
    const { deps, orderD, targetRequest } = notificationScene();

    for (const bad of [
      targetRequest("no-such-order"),
      targetRequest(orderD.id, { tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        createNotificationTarget(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
  });

  it("같은 멱등 키로 재호출하면 같은 안내 대상을 돌려주고(중복 대상 오류가 아니다) 중복 생성하지 않는다", () => {
    const { deps, orderD, targetRequest, notificationTargets } = notificationScene();

    const first = createNotificationTarget(deps, targetRequest(orderD.id, { idempotencyKey: "k" }));
    const replay = createNotificationTarget(deps, targetRequest(orderD.id, { idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(notificationTargets.list("tenant-a", orderD.id)).toEqual([first]);
  });
});
