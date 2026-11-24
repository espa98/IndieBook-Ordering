import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "../order/confirmOrderService";
import {
  buildNotificationTarget,
  type NotificationTarget,
  type NotificationTargetRepository,
} from "./createNotificationTarget";
import { notificationState } from "./notificationState";
import type { NotificationAttemptRepository } from "./recordNotificationAttempt";
import type { NotificationResultRepository } from "./recordNotificationResult";
import type { SecuredSnapshotDeps } from "./securedSnapshot";

export type RenotifyDeps = SecuredSnapshotDeps & {
  orders: OrderRepository;
  notificationTargets: NotificationTargetRepository;
  notificationAttempts: Pick<NotificationAttemptRepository, "list">;
  notificationResults: Pick<NotificationResultRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RenotifyRequest = {
  tenantId: string;
  targetId: string;
  createdBy: string;
  createdAt: string;
  idempotencyKey: string;
};

/**
 * 실패한 안내 대상을 재안내한다 (ST-M05). 원 대상·시도·결과는 보존하고,
 * 최신 확보량으로 새 대기 대상을 만들어 원 대상을 참조한다.
 */
export function renotify(deps: RenotifyDeps, request: RenotifyRequest): NotificationTarget {
  if (!isNonEmptyString(request.createdBy)) {
    invalid("createdBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("createdAt", request.createdAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "notification.renotify",
      key: request.idempotencyKey,
      payload: {
        targetId: request.targetId,
        createdBy: request.createdBy,
        createdAt: request.createdAt,
      },
    },
    () => {
      const original = deps.notificationTargets.get(request.tenantId, request.targetId);
      if (!original) {
        throw new AppError("NOT_FOUND");
      }
      // 실패로 기록된 안내만, 한 번만 재안내할 수 있다 (원 시도는 보존)
      const status = notificationState({
        attempts: deps.notificationAttempts.list(request.tenantId, original.id),
        results: deps.notificationResults.list(request.tenantId, original.id),
      });
      const alreadyRenoticed = deps.notificationTargets
        .list(request.tenantId, original.orderId)
        .some((t) => t.renoticeOfTargetId === original.id);
      if (status !== "FAILED" || alreadyRenoticed) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "only a failed notification that has not been renoticed can be renoticed",
        );
      }
      const order = deps.orders.get(request.tenantId, original.orderId)!;
      const next = buildNotificationTarget(deps, {
        tenantId: request.tenantId,
        order,
        mode: original.mode,
        createdBy: request.createdBy,
        createdAt: request.createdAt,
        now,
        renoticeOfTargetId: original.id,
      });
      deps.notificationTargets.save(next);
      return next;
    },
  );
}
