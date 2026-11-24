import { reserveStock } from "../../src/inventory/reserveStock";
import type {
  CreateNotificationTargetRequest,
  NotificationTarget,
} from "../../src/notification/createNotificationTarget";
import type {
  NotificationResult,
  RecordNotificationResultRequest,
} from "../../src/notification/recordNotificationResult";
import type { RenotifyRequest } from "../../src/notification/renotify";
import { recordNotificationResult } from "../../src/notification/recordNotificationResult";
import { recordNotificationAttempt } from "../../src/notification/recordNotificationAttempt";
import type {
  NotificationAttempt,
  RecordNotificationAttemptRequest,
} from "../../src/notification/recordNotificationAttempt";
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

export function createInMemoryNotificationAttemptRepository() {
  const all: NotificationAttempt[] = [];
  return {
    get(tenantId: string, id: string): NotificationAttempt | undefined {
      return all.find((a) => a.tenantId === tenantId && a.id === id);
    },
    list(tenantId: string, targetId: string): NotificationAttempt[] {
      return all.filter((a) => a.tenantId === tenantId && a.targetId === targetId);
    },
    save(attempt: NotificationAttempt): void {
      all.push(attempt);
    },
  };
}

/** copyScene에서 외부 발송 시도를 기록할 수 있는 세계 */
export function attemptScene() {
  const s = copyScene();
  const notificationAttempts = createInMemoryNotificationAttemptRepository();
  const notificationResults = createInMemoryNotificationResultRepository();
  const deps = { ...s.deps, notificationAttempts, notificationResults };
  let seq = 0;
  const attemptRequest = (
    extra: Partial<RecordNotificationAttemptRequest> = {},
  ): RecordNotificationAttemptRequest => ({
    tenantId: "tenant-a",
    targetId: s.target.id,
    channel: "PHONE",
    messageSnapshot: "[책방] 주문하신 도서 2권이 모두 입고되었습니다. 수령 가능합니다.",
    attemptedBy: "김직원",
    attemptedAt: "2026-03-04T06:58:00.000Z",
    idempotencyKey: `nat-${++seq}`,
    ...extra,
  });
  return { ...s, deps, notificationAttempts, notificationResults, attemptRequest };
}

export function createInMemoryNotificationResultRepository() {
  const all: NotificationResult[] = [];
  return {
    list(tenantId: string, targetId: string): NotificationResult[] {
      return all.filter((r) => r.tenantId === tenantId && r.targetId === targetId);
    },
    save(result: NotificationResult): void {
      all.push(result);
    },
  };
}

/** attemptScene에서 외부 발송 시도가 기록되어 결과를 기록할 수 있는 세계 */
export function resultScene() {
  const s = attemptScene();
  const { notificationResults, deps } = s;
  const attempt = recordNotificationAttempt(deps, s.attemptRequest({ idempotencyKey: "nat-scene" }));
  let seq = 0;
  const resultRequest = (
    extra: Partial<RecordNotificationResultRequest> = {},
  ): RecordNotificationResultRequest => ({
    tenantId: "tenant-a",
    attemptId: attempt.id,
    outcome: "MANUAL_RECORDED",
    note: "고객 본인과 통화하여 수령 가능 안내를 구두로 전달함",
    recordedBy: "김직원",
    resultAt: "2026-03-04T06:59:00.000Z",
    idempotencyKey: `nrs-${++seq}`,
    ...extra,
  });
  return { ...s, deps, attempt, notificationResults, resultRequest };
}

/** resultScene에서 안내 시도가 실패(FAILED)로 기록된 세계 */
export function failedNotificationScene() {
  const s = resultScene();
  recordNotificationResult(
    s.deps,
    s.resultRequest({ outcome: "FAILED", note: "전화를 받지 않아 안내하지 못함", idempotencyKey: "nrs-failed" }),
  );
  let seq = 0;
  const renotifyRequest = (
    extra: Partial<RenotifyRequest> = {},
  ): RenotifyRequest => ({
    tenantId: "tenant-a",
    targetId: s.target.id,
    createdBy: "김직원",
    createdAt: "2026-03-04T06:59:30.000Z",
    idempotencyKey: `ren-${++seq}`,
    ...extra,
  });
  return { ...s, renotifyRequest };
}
