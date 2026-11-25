import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import { AppError } from "../errors/AppError";
import type { CreateNotificationTargetRequest, NotificationTarget } from "../notification/createNotificationTarget";
import type { NotificationAttempt, RecordNotificationAttemptRequest } from "../notification/recordNotificationAttempt";
import type { NotificationCopy, RecordNotificationCopyRequest } from "../notification/recordNotificationCopy";
import type { NotificationResult, RecordNotificationResultRequest } from "../notification/recordNotificationResult";
import type { RenotifyRequest } from "../notification/renotify";
import type { SecuredSnapshotDeps } from "../notification/securedSnapshot";
import type { Order } from "../order/createDraftOrder";
import { loadFulfillments } from "./pgFulfillmentApi";
import { loadAllocationLedger } from "./pgReceivingApi";
import { loadBookLedger } from "./pgStockApi";
import {
  inTransaction,
  isCommandKeyConflict,
  isUuid,
  loadCommands,
  loadMembership,
  loadOrders,
  principalFor,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";

type Actor = { userId: string };
const iso = (value: Date) => value.toISOString();

export type CreateNotificationTargetBody = Omit<CreateNotificationTargetRequest, "createdBy">;
export type RecordNotificationCopyBody = Omit<RecordNotificationCopyRequest, "actedBy">;
export type RecordNotificationResultBody = Omit<RecordNotificationResultRequest, "recordedBy">;
export type RenotifyBody = Omit<RenotifyRequest, "createdBy">;
export type RecordNotificationAttemptBody = Omit<RecordNotificationAttemptRequest, "attemptedBy">;

const toTarget = (t: any): NotificationTarget => ({
  id: t.id,
  tenantId: t.tenant_id,
  orderId: t.order_id,
  mode: t.mode,
  ...(t.renotice_of_target_id === null ? {} : { renoticeOfTargetId: t.renotice_of_target_id }),
  lines: t.lines,
  securedTotal: t.secured_total,
  createdBy: t.created_by,
  createdAt: iso(t.created_at),
  recordedAt: iso(t.recorded_at),
});

const toAttempt = (a: any): NotificationAttempt => ({
  id: a.id,
  tenantId: a.tenant_id,
  targetId: a.target_id,
  channel: a.channel,
  messageSnapshot: a.message_snapshot,
  attemptedBy: a.attempted_by,
  attemptedAt: iso(a.attempted_at),
  recordedAt: iso(a.recorded_at),
});

const toResult = (r: any): NotificationResult => ({
  id: r.id,
  tenantId: r.tenant_id,
  targetId: r.target_id,
  attemptId: r.attempt_id,
  outcome: r.outcome,
  note: r.note,
  recordedBy: r.recorded_by,
  resultAt: iso(r.result_at),
  recordedAt: iso(r.recorded_at),
});

/** 한 실행에서 도메인이 새로 만든 기록 */
type Sink = { targets: NotificationTarget[]; copies: NotificationCopy[]; attempts: NotificationAttempt[]; results: NotificationResult[] };

/** 주문의 현재 확보량 계산에 필요한 원장(수령·재고 예약·입고 배분)을 적재해 도메인 저장소 모양으로 돌려준다 */
async function loadSecuredDeps(client: PoolClient, tenantId: string, order: Order): Promise<SecuredSnapshotDeps> {
  const fulfillments = await loadFulfillments(client, tenantId, order.id);
  const books = await Promise.all([...new Set(order.lines.map((l) => l.bookId))].map((id) => loadBookLedger(client, tenantId, id)));
  const reservations = books.flatMap((b) => b.reservations);
  const reservationReleases = books.flatMap((b) => b.releases);
  const reservationDeliveries = books.flatMap((b) => b.deliveries);
  const allocationIds = (await client.query("select id from public.ordering_receipt_allocations where tenant_id = $1 and order_id = $2", [tenantId, order.id])).rows.map((r) => r.id as string);
  const ledger = await loadAllocationLedger(client, tenantId, allocationIds);
  return {
    fulfillments: { list: () => fulfillments },
    stockReservations: { list: (_t: string, bookId: string) => reservations.filter((r) => r.bookId === bookId) },
    stockReservationReleases: { list: (_t: string, id: string) => reservationReleases.filter((r) => r.reservationId === id) },
    stockReservationDeliveries: { list: (_t: string, id: string) => reservationDeliveries.filter((d) => d.reservationId === id) },
    receiptAllocations: { listByOrder: () => ledger.allocations },
    allocationReleases: { list: (_t: string, id: string) => ledger.releases.filter((r) => r.allocationId === id) },
    allocationDeliveries: { list: (_t: string, id: string) => ledger.deliveries.filter((d) => d.allocationId === id) },
    allocationCancellations: { list: (_t: string, id: string) => ledger.cancellations.filter((c) => c.allocationId === id) },
  } as unknown as SecuredSnapshotDeps;
}

/**
 * 고객 안내(대상 생성·문구 복사·발송 시도·결과·재안내)를 Postgres 영속화 위에서 실행한다 (ST-M01~M06).
 * 같은 주문의 안내 쓰기는 `ntf:` 락으로 직렬화한다.
 */
export function createPgNotificationApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        if ((error as { code?: string }).code === "P0001") throw new AppError("BUSINESS_INVARIANT", (error as Error).message);
        if ((error as { code?: string }).code === "23505") throw new AppError("BUSINESS_INVARIANT", "a concurrent request already recorded this");
        throw error;
      }
    }
  };
  const mustNotWrite = () => {
    throw new Error("this command must not write orders");
  };

  /** 안내 대상·시도가 가리키는 주문을 찾는다(행의 주문은 바뀌지 않으므로 락 전에 조회해도 안전하다) */
  async function resolveOrderId(client: PoolClient, tenantId: string, target: { orderId: unknown } | { targetId: unknown } | { attemptId: unknown }): Promise<string | undefined> {
    if (!isUuid(tenantId)) return undefined;
    if ("orderId" in target) return isUuid(target.orderId) ? target.orderId : undefined;
    if ("attemptId" in target) {
      if (!isUuid(target.attemptId)) return undefined;
      return (await client.query("select t.order_id from public.ordering_notification_attempts a join public.ordering_notification_targets t on t.tenant_id = a.tenant_id and t.id = a.target_id where a.tenant_id = $1 and a.id = $2", [tenantId, target.attemptId])).rows[0]?.order_id;
    }
    if (!isUuid(target.targetId)) return undefined;
    return (await client.query("select order_id from public.ordering_notification_targets where tenant_id = $1 and id = $2", [tenantId, target.targetId])).rows[0]?.order_id;
  }

  /** 주문의 안내 상태 전체를 `ntf:` 락 아래 적재해 도메인 저장소를 만들고, 새 기록만 모아 같은 트랜잭션에 저장한다 */
  const execute = <B extends { tenantId: string; idempotencyKey: string }, R>(
    actor: Actor,
    request: B,
    where: { orderId: unknown } | { targetId: unknown } | { attemptId: unknown },
    needSecured: boolean,
    run: (ctx: { deps: Record<string, unknown>; principal: ReturnType<typeof principalFor>; rest: Omit<B, "tenantId"> }) => R,
  ): Promise<R> =>
    withRetry(() =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
        const orderId = await resolveOrderId(client, request.tenantId, where);
        if (orderId) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ntf:${request.tenantId}:${orderId}`]);
        const [order] = orderId ? await loadOrders(client, request.tenantId, { orderId }) : [];
        const secured = order && needSecured ? await loadSecuredDeps(client, request.tenantId, order) : {};
        const targets: NotificationTarget[] = order
          ? (await client.query("select * from public.ordering_notification_targets where tenant_id = $1 and order_id = $2 order by recorded_at, id", [request.tenantId, order.id])).rows.map(toTarget)
          : [];
        const attempts: NotificationAttempt[] = order
          ? (await client.query("select * from public.ordering_notification_attempts where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, targets.map((t) => t.id)])).rows.map(toAttempt)
          : [];
        const results: NotificationResult[] = order
          ? (await client.query("select * from public.ordering_notification_results where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, targets.map((t) => t.id)])).rows.map(toResult)
          : [];
        const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
        const known = new Set(idempotency.keys());
        const sink: Sink = { targets: [], copies: [], attempts: [], results: [] };
        const { tenantId: _t, ...rest } = request;
        void _t;
        const result = run({
          principal,
          rest,
          deps: {
            ...secured,
            orders: { get: (_t2: string, id: string) => (order && order.id === id ? order : undefined), list: () => (order ? [order] : []), save: mustNotWrite },
            notificationTargets: {
              get: (_t2: string, id: string) => targets.find((t) => t.id === id),
              list: () => targets,
              save: (t: NotificationTarget) => void sink.targets.push(t),
            },
            notificationCopies: { list: () => [], save: (c: NotificationCopy) => void sink.copies.push(c) },
            notificationAttempts: {
              get: (_t2: string, id: string) => attempts.find((a) => a.id === id),
              list: (_t2: string, targetId: string) => attempts.filter((a) => a.targetId === targetId),
              save: (a: NotificationAttempt) => void sink.attempts.push(a),
            },
            notificationResults: {
              list: (_t2: string, targetId: string) => results.filter((x) => x.targetId === targetId),
              save: (x: NotificationResult) => void sink.results.push(x),
            },
            idempotency,
          },
        });
        for (const t of sink.targets) {
          await client.query(
            "insert into public.ordering_notification_targets (id, tenant_id, order_id, mode, renotice_of_target_id, lines, secured_total, created_by, created_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            [t.id, t.tenantId, t.orderId, t.mode, t.renoticeOfTargetId ?? null, JSON.stringify(t.lines), t.securedTotal, t.createdBy, t.createdAt, t.recordedAt],
          );
        }
        for (const c of sink.copies) {
          await client.query("insert into public.ordering_notification_copies (id, tenant_id, target_id, action, acted_by, acted_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)", [c.id, c.tenantId, c.targetId, c.action, c.actedBy, c.actedAt, c.recordedAt]);
        }
        for (const a of sink.attempts) {
          await client.query(
            "insert into public.ordering_notification_attempts (id, tenant_id, target_id, channel, message_snapshot, attempted_by, attempted_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
            [a.id, a.tenantId, a.targetId, a.channel, a.messageSnapshot, a.attemptedBy, a.attemptedAt, a.recordedAt],
          );
        }
        for (const x of sink.results) {
          await client.query(
            "insert into public.ordering_notification_results (id, tenant_id, target_id, attempt_id, outcome, note, recorded_by, result_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [x.id, x.tenantId, x.targetId, x.attemptId, x.outcome, x.note, x.recordedBy, x.resultAt, x.recordedAt],
          );
        }
        await saveNewCommands(client, idempotency, known);
        return result;
      }),
    );

  return {
    createNotificationTarget: (actor: Actor, request: CreateNotificationTargetBody): Promise<NotificationTarget> =>
      execute(actor, request, { orderId: request.orderId }, true, (c) => authorizedActions.createNotificationTarget(c.deps as never, c.principal, c.rest)),
    recordNotificationCopy: (actor: Actor, request: RecordNotificationCopyBody): Promise<NotificationCopy> =>
      execute(actor, request, { targetId: request.targetId }, false, (c) => authorizedActions.recordNotificationCopy(c.deps as never, c.principal, c.rest)),
    recordNotificationAttempt: (actor: Actor, request: RecordNotificationAttemptBody): Promise<NotificationAttempt> =>
      execute(actor, request, { targetId: request.targetId }, true, (c) => authorizedActions.recordNotificationAttempt(c.deps as never, c.principal, c.rest)),
    recordNotificationResult: (actor: Actor, request: RecordNotificationResultBody): Promise<NotificationResult> =>
      execute(actor, request, { attemptId: request.attemptId }, false, (c) => authorizedActions.recordNotificationResult(c.deps as never, c.principal, c.rest)),
    renotify: (actor: Actor, request: RenotifyBody): Promise<NotificationTarget> =>
      execute(actor, request, { targetId: request.targetId }, true, (c) => authorizedActions.renotify(c.deps as never, c.principal, c.rest)),
  };
}
