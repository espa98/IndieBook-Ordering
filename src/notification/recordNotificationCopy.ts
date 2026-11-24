import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { AppError } from "../errors/AppError";
import type { NotificationTargetRepository } from "./createNotificationTarget";

export const NOTIFICATION_COPY_ACTIONS = ["PREVIEW", "COPY", "SHARE"] as const;
export type NotificationCopyAction = (typeof NOTIFICATION_COPY_ACTIONS)[number];

/** 문구 미리보기·복사·공유 기록 (추가 전용, ST-M02). 발송 증빙이 아니다. */
export type NotificationCopy = {
  id: string;
  tenantId: string;
  targetId: string;
  action: NotificationCopyAction;
  actedBy: string;
  actedAt: string;
  recordedAt: string;
};

export type NotificationCopyRepository = {
  list(tenantId: string, targetId: string): NotificationCopy[];
  save(copy: NotificationCopy): void;
};

export type RecordNotificationCopyDeps = {
  notificationTargets: NotificationTargetRepository;
  notificationCopies: NotificationCopyRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RecordNotificationCopyRequest = {
  tenantId: string;
  targetId: string;
  action: NotificationCopyAction;
  actedBy: string;
  actedAt: string;
  idempotencyKey: string;
};

export function recordNotificationCopy(
  deps: RecordNotificationCopyDeps,
  request: RecordNotificationCopyRequest,
): NotificationCopy {
  if (!NOTIFICATION_COPY_ACTIONS.includes(request.action)) {
    invalid("action", "must be PREVIEW, COPY or SHARE");
  }
  if (!isNonEmptyString(request.actedBy)) {
    invalid("actedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("actedAt", request.actedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "notification.record-copy",
      key: request.idempotencyKey,
      payload: {
        targetId: request.targetId,
        action: request.action,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
      },
    },
    () => {
      const target = deps.notificationTargets.get(request.tenantId, request.targetId);
      if (!target) {
        throw new AppError("NOT_FOUND");
      }
      const copy: NotificationCopy = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        targetId: target.id,
        action: request.action,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
        recordedAt: now.toISOString(),
      };
      deps.notificationCopies.save(copy);
      return copy;
    },
  );
}
