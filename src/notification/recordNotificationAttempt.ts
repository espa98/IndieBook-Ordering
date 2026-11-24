import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "../order/confirmOrderService";
import {
  sameSnapshot,
  type NotificationTargetRepository,
} from "./createNotificationTarget";
import { securedSnapshot, type SecuredSnapshotDeps } from "./securedSnapshot";

export const NOTIFICATION_CHANNELS = ["PHONE", "SMS", "MESSENGER", "VISIT", "OTHER"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * 외부 발송 시도 기록 (추가 전용, ST-M03). 직원이 시스템 밖에서 실제로 안내를 시도했다는 사실이며
 * 발송 당시 문구를 스냅샷으로 보존한다. 수신·읽음을 뜻하지 않는다.
 */
export type NotificationAttempt = {
  id: string;
  tenantId: string;
  targetId: string;
  channel: NotificationChannel;
  messageSnapshot: string;
  attemptedBy: string;
  attemptedAt: string;
  recordedAt: string;
};

export type NotificationAttemptRepository = {
  get(tenantId: string, id: string): NotificationAttempt | undefined;
  list(tenantId: string, targetId: string): NotificationAttempt[];
  save(attempt: NotificationAttempt): void;
};

export type RecordNotificationAttemptDeps = SecuredSnapshotDeps & {
  orders: OrderRepository;
  notificationTargets: NotificationTargetRepository;
  notificationAttempts: NotificationAttemptRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RecordNotificationAttemptRequest = {
  tenantId: string;
  targetId: string;
  channel: NotificationChannel;
  messageSnapshot: string;
  attemptedBy: string;
  attemptedAt: string;
  idempotencyKey: string;
};

export function recordNotificationAttempt(
  deps: RecordNotificationAttemptDeps,
  request: RecordNotificationAttemptRequest,
): NotificationAttempt {
  if (!NOTIFICATION_CHANNELS.includes(request.channel)) {
    invalid("channel", "must be PHONE, SMS, MESSENGER, VISIT or OTHER");
  }
  for (const field of ["messageSnapshot", "attemptedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("attemptedAt", request.attemptedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "notification.record-attempt",
      key: request.idempotencyKey,
      payload: {
        targetId: request.targetId,
        channel: request.channel,
        messageSnapshot: request.messageSnapshot,
        attemptedBy: request.attemptedBy,
        attemptedAt: request.attemptedAt,
      },
    },
    () => {
      const target = deps.notificationTargets.get(request.tenantId, request.targetId);
      if (!target) {
        throw new AppError("NOT_FOUND");
      }
      // 확보량이 바뀌어 obsolete가 된 대상으로는 발송하지 않는다. 최신 확보량으로 재안내 대상을 만든다 (ST-M06)
      const order = deps.orders.get(request.tenantId, target.orderId)!;
      if (!sameSnapshot(target, securedSnapshot(deps, request.tenantId, order))) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "the notification target is obsolete: secured quantities have changed",
        );
      }
      // 한 안내 대상에는 한 번만 시도한다. 실패하면 원 시도를 보존한 채 재안내 대상을 새로 만든다 (ST-M05)
      if (deps.notificationAttempts.list(request.tenantId, target.id).length > 0) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "this notification target has already been attempted",
        );
      }
      const attempt: NotificationAttempt = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        targetId: target.id,
        channel: request.channel,
        messageSnapshot: request.messageSnapshot,
        attemptedBy: request.attemptedBy,
        attemptedAt: request.attemptedAt,
        recordedAt: now.toISOString(),
      };
      deps.notificationAttempts.save(attempt);
      return attempt;
    },
  );
}
