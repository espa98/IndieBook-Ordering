import { reserveStock } from "../../src/inventory/reserveStock";
import type {
  CreateNotificationTargetRequest,
  NotificationTarget,
} from "../../src/notification/createNotificationTarget";
import type {
  NotificationCopy,
  RecordNotificationCopyRequest,
} from "../../src/notification/recordNotificationCopy";
import { createNotificationTarget } from "../../src/notification/createNotificationTarget";
import { fulfillmentScene } from "./fulfillmentFixtures";

export function createInMemoryNotificationTargetRepository() {
  const all: NotificationTarget[] = [];
  return {
    get(tenantId: string, id: string): NotificationTarget | undefined {
      return all.find((t) => t.tenantId === tenantId && t.id === id);
    },
    list(tenantId: string, orderId: string): NotificationTarget[] {
      return all.filter((t) => t.tenantId === tenantId && t.orderId === orderId);
    },
    save(target: NotificationTarget): void {
      all.push(target);
    },
  };
}

/**
 * 주문 D(2권, 예약 2 = 전체 확보), 주문 B(3권, 입고 배분 3 = 전체 확보),
 * 주문 E(3권, 예약 1 = 부분 확보), 주문 A(조달 중, 확보 0)가 있는 세계
 */
export function notificationScene() {
  const f = fulfillmentScene();
  const notificationTargets = createInMemoryNotificationTargetRepository();
  const deps = { ...f.deps, notificationTargets };
  const orderE = f.w.addOrder([{ bookId: "book-1", quantity: 3, unitPriceKrw: "15000" }]);
  reserveStock(deps, {
    tenantId: "tenant-a",
    orderId: orderE.id,
    orderLineId: orderE.lines[0]!.lineId,
    quantity: 1,
    reservedBy: "김직원",
    reservedAt: "2026-03-04T06:41:00.000Z",
    idempotencyKey: "res-E",
  });
  let seq = 0;
  const targetRequest = (
    orderId: string,
    extra: Partial<CreateNotificationTargetRequest> = {},
  ): CreateNotificationTargetRequest => ({
    tenantId: "tenant-a",
    orderId,
    createdBy: "김직원",
    createdAt: "2026-03-04T06:55:00.000Z",
    idempotencyKey: `ntg-${++seq}`,
    ...extra,
  });
  return { ...f, deps, orderE, notificationTargets, targetRequest };
}

export function createInMemoryNotificationCopyRepository() {
  const all: NotificationCopy[] = [];
  return {
    list(tenantId: string, targetId: string): NotificationCopy[] {
      return all.filter((c) => c.tenantId === tenantId && c.targetId === targetId);
    },
    save(copy: NotificationCopy): void {
      all.push(copy);
    },
  };
}

/** notificationScene에서 주문 D(전체 확보)의 안내 대상이 만들어진 세계 */
export function copyScene() {
  const s = notificationScene();
  const notificationCopies = createInMemoryNotificationCopyRepository();
  const deps = { ...s.deps, notificationCopies };
  const target = createNotificationTarget(deps, s.targetRequest(s.orderD.id, { idempotencyKey: "ntg-scene" }));
  let seq = 0;
  const copyRequest = (
    extra: Partial<RecordNotificationCopyRequest> = {},
  ): RecordNotificationCopyRequest => ({
    tenantId: "tenant-a",
    targetId: target.id,
    action: "COPY",
    actedBy: "김직원",
    actedAt: "2026-03-04T06:56:00.000Z",
    idempotencyKey: `ncp-${++seq}`,
    ...extra,
  });
  return { ...s, deps, target, notificationCopies, copyRequest };
}
