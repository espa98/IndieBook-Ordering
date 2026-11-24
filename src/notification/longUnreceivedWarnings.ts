import type { OrderRepository } from "../order/confirmOrderService";
import type { NotificationTargetRepository } from "./createNotificationTarget";
import type { NotificationAttemptRepository } from "./recordNotificationAttempt";
import type { NotificationResultRepository } from "./recordNotificationResult";
import { securedSnapshot, type SecuredSnapshotDeps } from "./securedSnapshot";

export type LongUnreceivedWarning = {
  orderId: string;
  targetId: string;
  notifiedAt: string;
  daysElapsed: number;
  securedQuantity: number;
};

export type LongUnreceivedDeps = SecuredSnapshotDeps & {
  orders: Pick<OrderRepository, "list">;
  notificationTargets: Pick<NotificationTargetRepository, "list">;
  notificationAttempts: Pick<NotificationAttemptRepository, "list">;
  notificationResults: Pick<NotificationResultRepository, "list">;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 확보 안내를 마친 뒤 thresholdDays(기본 7일, 서점별 설정 가능)가 지나도 아직 수령하지 않은
 * 확보분이 남은 주문을 경고 목록으로 낸다. 목록만 산출하며 자동 취소·비용 부과·상태 변경은 하지 않는다 (DEC-07).
 */
export function longUnreceivedWarnings(
  deps: LongUnreceivedDeps,
  tenantId: string,
  now: Date,
  thresholdDays = 7,
): LongUnreceivedWarning[] {
  const warnings: LongUnreceivedWarning[] = [];
  for (const order of deps.orders.list(tenantId)) {
    const notified = deps.notificationTargets
      .list(tenantId, order.id)
      .flatMap((target) =>
        deps.notificationResults
          .list(tenantId, target.id)
          .filter((r) => r.outcome === "MANUAL_RECORDED")
          .map((r) => ({ target, resultAt: r.resultAt })),
      )
      .sort((a, b) => Date.parse(b.resultAt) - Date.parse(a.resultAt))[0];
    if (!notified) continue;
    const daysElapsed = Math.floor((now.getTime() - Date.parse(notified.resultAt)) / DAY_MS);
    if (daysElapsed < thresholdDays) continue;
    const securedQuantity = securedSnapshot(deps, tenantId, order).reduce(
      (sum, l) => sum + l.securedQuantity,
      0,
    );
    if (securedQuantity < 1) continue;
    warnings.push({
      orderId: order.id,
      targetId: notified.target.id,
      notifiedAt: notified.resultAt,
      daysElapsed,
      securedQuantity,
    });
  }
  return warnings;
}
