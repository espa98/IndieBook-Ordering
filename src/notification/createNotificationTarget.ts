import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "../order/confirmOrderService";
import type { Order } from "../order/createDraftOrder";
import {
  securedSnapshot,
  type SecuredLine,
  type SecuredSnapshotDeps,
} from "./securedSnapshot";

/**
 * 고객 안내 대상 (추가 전용, ST-M01). 생성 시점의 확보량 스냅샷을 보존하며
 * 발송 시도·결과는 별도 기록이다 (BR-M01).
 */
export type NotificationTarget = {
  id: string;
  tenantId: string;
  orderId: string;
  mode: "FULL" | "PARTIAL";
  /** 재안내로 생긴 대상이면 보존된 원 대상 (ST-M05) */
  renoticeOfTargetId?: string;
  lines: SecuredLine[];
  securedTotal: number;
  createdBy: string;
  createdAt: string;
  recordedAt: string;
};

export type NotificationTargetRepository = {
  get(tenantId: string, id: string): NotificationTarget | undefined;
  list(tenantId: string, orderId: string): NotificationTarget[];
  save(target: NotificationTarget): void;
};

export type CreateNotificationTargetDeps = SecuredSnapshotDeps & {
  orders: OrderRepository;
  notificationTargets: NotificationTargetRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CreateNotificationTargetRequest = {
  tenantId: string;
  orderId: string;
  mode?: "FULL" | "PARTIAL";
  createdBy: string;
  createdAt: string;
  idempotencyKey: string;
};

/** 현재 확보량으로 안내 대상을 만든다(모드 규칙 검증 포함). 저장과 중복 검사는 하지 않는다. */
export function buildNotificationTarget(
  deps: SecuredSnapshotDeps,
  params: {
    tenantId: string;
    order: Order;
    mode: "FULL" | "PARTIAL";
    createdBy: string;
    createdAt: string;
    now: Date;
    renoticeOfTargetId?: string;
  },
): NotificationTarget {
  const lines = securedSnapshot(deps, params.tenantId, params.order);
  const securedTotal = lines.reduce((sum, l) => sum + l.securedQuantity, 0);
  // 전체 확보 안내는 아직 받지 않은 수량이 모두 확보된 주문에만, 부분 확보 안내는 확보량이 있을 때만 만든다 (DEC-05)
  const fullySecured = lines.every(
    (l) => l.securedQuantity + l.receivedQuantity >= l.orderedQuantity,
  );
  if (params.mode === "FULL" && !fullySecured) {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "a full-secured notice requires every order line to be fully secured",
    );
  }
  if (params.mode === "PARTIAL" && securedTotal < 1) {
    throw new AppError("BUSINESS_INVARIANT", "nothing is secured to notify about");
  }
  return {
    id: crypto.randomUUID(),
    tenantId: params.tenantId,
    orderId: params.order.id,
    mode: params.mode,
    ...(params.renoticeOfTargetId === undefined
      ? {}
      : { renoticeOfTargetId: params.renoticeOfTargetId }),
    lines,
    securedTotal,
    createdBy: params.createdBy,
    createdAt: params.createdAt,
    recordedAt: params.now.toISOString(),
  };
}

/** 대상의 확보 스냅샷이 현재 확보량과 같은지 본다. 다르면 대상은 obsolete다 (ST-M06). */
export function sameSnapshot(target: NotificationTarget, lines: SecuredLine[]): boolean {
  return (
    target.lines.length === lines.length &&
    target.lines.every((l, i) => {
      const current = lines[i]!;
      return (
        l.orderLineId === current.orderLineId &&
        l.securedQuantity === current.securedQuantity &&
        l.receivedQuantity === current.receivedQuantity
      );
    })
  );
}

export function createNotificationTarget(
  deps: CreateNotificationTargetDeps,
  request: CreateNotificationTargetRequest,
): NotificationTarget {
  if (request.mode !== undefined && request.mode !== "FULL" && request.mode !== "PARTIAL") {
    invalid("mode", "must be FULL or PARTIAL");
  }
  if (!isNonEmptyString(request.createdBy)) {
    invalid("createdBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("createdAt", request.createdAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "notification.create-target",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        mode: request.mode ?? "FULL",
        createdBy: request.createdBy,
        createdAt: request.createdAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) {
        throw new AppError("NOT_FOUND");
      }
      const target = buildNotificationTarget(deps, {
        tenantId: request.tenantId,
        order,
        mode: request.mode ?? "FULL",
        createdBy: request.createdBy,
        createdAt: request.createdAt,
        now,
      });
      // 같은 확보 스냅샷에 대한 안내 대상을 중복으로 만들지 않는다. 확보량이 바뀐 뒤에는 새 대상이 가능하다 (BR-M01)
      if (
        deps.notificationTargets
          .list(request.tenantId, order.id)
          .some((t) => sameSnapshot(t, target.lines))
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "a notification target already exists for the current secured quantities",
        );
      }
      deps.notificationTargets.save(target);
      return target;
    },
  );
}
