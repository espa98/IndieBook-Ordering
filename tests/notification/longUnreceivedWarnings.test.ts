import { describe, it, expect } from "vitest";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { longUnreceivedWarnings } from "../../src/notification/longUnreceivedWarnings";
import { recordNotificationResult } from "../../src/notification/recordNotificationResult";
import { resultScene } from "../helpers/notificationFixtures";

const at = (iso: string) => new Date(iso);

describe("longUnreceivedWarnings: 확보 안내 후 장기 미수령 경고 (DEC-07, DASH-005)", () => {
  it("확보 안내를 마친 뒤 7일이 지나도 수령하지 않은 주문만 경고하고, 경고는 목록 산출일 뿐 주문·결제를 바꾸지 않는다", () => {
    const { deps, resultRequest, orderD, target } = resultScene();
    recordNotificationResult(deps, resultRequest({ outcome: "MANUAL_RECORDED", resultAt: "2026-03-04T06:59:00.000Z" }));
    const orderBefore = structuredClone(deps.orders.get("tenant-a", orderD.id));
    const warn = (now: string) => longUnreceivedWarnings(deps, "tenant-a", at(now));

    expect(warn("2026-03-11T06:58:59.000Z")).toEqual([]); // 6일 23시간 59분
    expect(warn("2026-03-11T06:59:00.000Z")).toEqual([
      {
        orderId: orderD.id,
        targetId: target.id,
        notifiedAt: "2026-03-04T06:59:00.000Z",
        daysElapsed: 7,
        securedQuantity: 2,
      },
    ]);
    expect(deps.orders.get("tenant-a", orderD.id)).toEqual(orderBefore); // 자동 취소·변경 없음
  });

  it("안내가 실패했거나 확보분을 모두 수령했으면 경고하지 않고, 기준일은 서점별로 바꿀 수 있다", () => {
    const failed = resultScene();
    recordNotificationResult(failed.deps, failed.resultRequest({ outcome: "FAILED", note: "연락 두절" }));
    expect(longUnreceivedWarnings(failed.deps, "tenant-a", at("2026-04-30T00:00:00.000Z"))).toEqual([]);

    const received = resultScene();
    recordNotificationResult(received.deps, received.resultRequest({ outcome: "MANUAL_RECORDED" }));
    received.pay(received.orderD.id, "30000");
    postFulfillment(received.deps, received.fulfillRequest({
      sources: [{ kind: "STOCK_RESERVATION", sourceId: received.reservation.id, quantity: 2 }],
    }));
    expect(longUnreceivedWarnings(received.deps, "tenant-a", at("2026-04-30T00:00:00.000Z"))).toEqual([]);

    const custom = resultScene();
    recordNotificationResult(custom.deps, custom.resultRequest({ outcome: "MANUAL_RECORDED", resultAt: "2026-03-04T06:59:00.000Z" }));
    expect(longUnreceivedWarnings(custom.deps, "tenant-a", at("2026-03-07T06:59:00.000Z"), 3)).toHaveLength(1);
    expect(longUnreceivedWarnings(custom.deps, "tenant-a", at("2026-03-07T06:58:00.000Z"), 3)).toEqual([]);
  });
});
