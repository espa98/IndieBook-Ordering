import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { CorrectPaymentRequest, PaymentCorrection } from "../payment/correctPayment";
import { AppError } from "../errors/AppError";
import type { Order } from "../order/createDraftOrder";
import type { PaymentConfirmation, ConfirmPaymentRequest } from "../payment/confirmPayment";
import type { PaymentVoid, VoidPaymentRequest } from "../payment/voidPayment";
import type { RefundConfirmation } from "../payment/confirmRefund";
import type { DecideRefundRequestRequest, DecideRefundRequestResult } from "../payment/decideRefundRequest";
import type { OpenRefundTaskRequest, RefundTask } from "../payment/openRefundTask";
import type { Payment, RecordPaymentRequest } from "../payment/recordPayment";
import type { RefundAttempt } from "../payment/reportRefundAttempt";
import type { RefundRequest, RefundRequestDecision, RequestRefundRequest } from "../payment/requestRefund";
import type { RefundAttemptResolution } from "../payment/resolveRefundAttempt";
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
const money = (value: string | number) => String(value);

/** 한 주문의 결제·환급 원장 전체. 모든 결제 명령은 이 집합을 적재해 실행한다. */
export type PaymentLedger = {
  order: Order;
  payments: Payment[];
  confirmations: PaymentConfirmation[];
  voids: PaymentVoid[];
  corrections: PaymentCorrection[];
  tasks: RefundTask[];
  requests: RefundRequest[];
  decisions: RefundRequestDecision[];
  refunds: RefundConfirmation[];
  attempts: RefundAttempt[];
  resolutions: RefundAttemptResolution[];
};

export async function loadLedger(client: PoolClient, order: Order): Promise<PaymentLedger> {
  const t = order.tenantId;
  const q = async (table: string, extra = "") =>
    (await client.query(`select * from public.${table} where tenant_id = $1 ${extra}`, [t, order.id])).rows;
  const payments = (await q("ordering_payments", "and order_id = $2 order by recorded_at, id")).map(
    (p): Payment => ({
      id: p.id,
      tenantId: p.tenant_id,
      orderId: p.order_id,
      method: p.method,
      amountKrw: money(p.amount_krw),
      externalReference: p.external_reference,
      paidAt: iso(p.paid_at),
      recordedBy: p.recorded_by,
      recordedAt: iso(p.recorded_at),
    }),
  );
  const paymentIds = payments.map((p) => p.id);
  const byPayment = async (table: string) =>
    (await client.query(`select * from public.${table} where tenant_id = $1 and payment_id = any($2::uuid[]) order by recorded_at, id`, [t, paymentIds])).rows;
  const confirmations = (await byPayment("ordering_payment_confirmations")).map(
    (c): PaymentConfirmation => ({
      id: c.id,
      tenantId: c.tenant_id,
      paymentId: c.payment_id,
      evidence: c.evidence,
      confirmedBy: c.confirmed_by,
      confirmedAt: iso(c.confirmed_at),
      verificationSource: c.verification_source,
      recordedAt: iso(c.recorded_at),
    }),
  );
  const voids = (await byPayment("ordering_payment_voids")).map(
    (v): PaymentVoid => ({
      id: v.id,
      tenantId: v.tenant_id,
      paymentId: v.payment_id,
      reason: v.reason,
      voidedBy: v.voided_by,
      voidedAt: iso(v.voided_at),
      recordedAt: iso(v.recorded_at),
    }),
  );
  const corrections = (await q("ordering_payment_corrections", "and order_id = $2 order by recorded_at, id")).map(
    (c): PaymentCorrection => ({
      id: c.id,
      tenantId: c.tenant_id,
      orderId: c.order_id,
      paymentId: c.payment_id,
      reducedKrw: money(c.reduced_krw),
      reason: c.reason,
      evidence: c.evidence,
      correctedBy: c.corrected_by,
      correctedAt: iso(c.corrected_at),
      recordedAt: iso(c.recorded_at),
    }),
  );
  const tasks = (await q("ordering_refund_tasks", "and order_id = $2 order by recorded_at, id")).map(
    (r): RefundTask => ({
      id: r.id,
      tenantId: r.tenant_id,
      orderId: r.order_id,
      requiredKrw: money(r.required_krw),
      openedBy: r.opened_by,
      openedAt: iso(r.opened_at),
      recordedAt: iso(r.recorded_at),
    }),
  );
  const requests = (await q("ordering_refund_requests", "and order_id = $2 order by recorded_at, id")).map(
    (r): RefundRequest => ({
      id: r.id,
      tenantId: r.tenant_id,
      refundTaskId: r.refund_task_id,
      orderId: r.order_id,
      paymentId: r.payment_id,
      amountKrw: money(r.amount_krw),
      evidence: r.evidence,
      requestedBy: r.requested_by,
      requestedAt: iso(r.requested_at),
      recordedAt: iso(r.recorded_at),
    }),
  );
  const decisions = (
    await client.query("select * from public.ordering_refund_request_decisions where tenant_id = $1 and request_id = any($2::uuid[]) order by recorded_at, id", [t, requests.map((r) => r.id)])
  ).rows.map(
    (d): RefundRequestDecision => ({
      id: d.id,
      tenantId: d.tenant_id,
      requestId: d.request_id,
      kind: d.kind,
      decidedBy: d.decided_by,
      decidedAt: iso(d.decided_at),
      recordedAt: iso(d.recorded_at),
    }),
  );
  const refunds = (await q("ordering_refund_confirmations", "and order_id = $2 order by recorded_at, id")).map(
    (r): RefundConfirmation => ({
      id: r.id,
      tenantId: r.tenant_id,
      refundTaskId: r.refund_task_id,
      orderId: r.order_id,
      paymentId: r.payment_id,
      amountKrw: money(r.amount_krw),
      evidence: r.evidence,
      confirmedBy: r.confirmed_by,
      confirmedAt: iso(r.confirmed_at),
      ...(r.refund_request_id === null ? {} : { refundRequestId: r.refund_request_id }),
      verificationSource: r.verification_source,
      recordedAt: iso(r.recorded_at),
    }),
  );
  const attempts = (await q("ordering_refund_attempts", "and order_id = $2 order by recorded_at, id")).map(
    (a): RefundAttempt => ({
      id: a.id,
      tenantId: a.tenant_id,
      refundTaskId: a.refund_task_id,
      orderId: a.order_id,
      paymentId: a.payment_id,
      amountKrw: money(a.amount_krw),
      result: a.result,
      reason: a.reason,
      reportedBy: a.reported_by,
      reportedAt: iso(a.reported_at),
      recordedAt: iso(a.recorded_at),
    }),
  );
  const resolutions = (
    await client.query("select * from public.ordering_refund_attempt_resolutions where tenant_id = $1 and attempt_id = any($2::uuid[]) order by recorded_at, id", [t, attempts.map((a) => a.id)])
  ).rows.map(
    (r): RefundAttemptResolution => ({
      id: r.id,
      tenantId: r.tenant_id,
      attemptId: r.attempt_id,
      refundTaskId: tasks.find((task) => attempts.some((a) => a.id === r.attempt_id && a.refundTaskId === task.id))?.id ?? "",
      outcome: r.outcome,
      evidence: r.evidence,
      resolvedBy: r.resolved_by,
      resolvedAt: iso(r.resolved_at),
      recordedAt: iso(r.recorded_at),
    }),
  );
  return { order, payments, confirmations, voids, corrections, tasks, requests, decisions, refunds, attempts, resolutions };
}

/** 요청이 가리키는 결제·환급 업무·환급 요청에서 주문을 찾는다. 행의 주문은 바뀌지 않으므로 락 전에 조회해도 안전하다 */
async function resolveOrderId(
  client: PoolClient,
  tenantId: string,
  target: { table: "ordering_payments" | "ordering_refund_tasks" | "ordering_refund_requests"; id: unknown } | { orderId: unknown },
): Promise<string | undefined> {
  if (!isUuid(tenantId)) return undefined;
  if ("orderId" in target) return isUuid(target.orderId) ? target.orderId : undefined;
  if (!isUuid(target.id)) return undefined;
  const rows = (await client.query(`select order_id from public.${target.table} where tenant_id = $1 and id = $2`, [tenantId, target.id])).rows;
  return rows[0]?.order_id;
}

export type RecordPaymentBody = Omit<RecordPaymentRequest, "recordedBy">;
export type ConfirmPaymentBody = Omit<ConfirmPaymentRequest, "confirmedBy">;
export type OpenRefundTaskBody = Omit<OpenRefundTaskRequest, "openedBy">;
export type RequestRefundBody = Omit<RequestRefundRequest, "requestedBy">;
export type VoidPaymentBody = Omit<VoidPaymentRequest, "voidedBy">;
export type CorrectPaymentBody = Omit<CorrectPaymentRequest, "actorRole" | "correctedBy">;
export type DecideRefundRequestBody = Omit<DecideRefundRequestRequest, "actorRole" | "decidedBy">;

/**
 * 결제·환급 명령을 Postgres 영속화 위에서 실행한다 (E7 권고안 a). 주문 하나의 결제 원장 전체를
 * `(서점, 주문)` 락을 잡고 적재해 기존 도메인을 그대로 실행하고, 새로 생긴 기록을 같은 트랜잭션에 저장한다.
 * 같은 락을 DB 트리거도 잡아 환급 한도·요청당 1회 결정·유일 외부 거래를 DB가 끝까지 강제한다.
 */
export function createPgPaymentApi(deps: { pool: PoolLike }) {
  async function once<T>(
    actor: Actor,
    request: { tenantId: string; idempotencyKey?: unknown },
    target: Parameters<typeof resolveOrderId>[2],
    extra: { externalReference?: unknown },
    run: (ctx: { ledger: PaymentLedger | undefined; principal: ReturnType<typeof principalFor>; sink: Sink; idempotency: Awaited<ReturnType<typeof loadCommands>> }) => T,
  ): Promise<T> {
    return inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);

      const orderId = await resolveOrderId(client, request.tenantId, target);
      const [order] = orderId === undefined ? [] : await loadOrders(client, request.tenantId, { orderId, lock: "share" });
      let ledger: PaymentLedger | undefined;
      if (order) {
        // 같은 주문의 결제·환급을 직렬화한다. 락을 잡은 뒤에 읽어야 먼저 커밋된 기록이 보인다
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`pay:${order.tenantId}:${order.id}`]);
        ledger = await loadLedger(client, order);
      }
      // 같은 외부 거래의 중복 검사는 서점 전체가 범위라 같은 참조의 기존 결제를 따로 적재한다
      const sameReference =
        typeof extra.externalReference === "string" && isUuid(request.tenantId)
          ? (
              await client.query("select * from public.ordering_payments where tenant_id = $1 and external_reference = $2", [request.tenantId, extra.externalReference.trim()])
            ).rows.map(
              (p): Payment => ({
                id: p.id,
                tenantId: p.tenant_id,
                orderId: p.order_id,
                method: p.method,
                amountKrw: money(p.amount_krw),
                externalReference: p.external_reference,
                paidAt: iso(p.paid_at),
                recordedBy: p.recorded_by,
                recordedAt: iso(p.recorded_at),
              }),
            )
          : [];
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const knownCommands = new Set(idempotency.keys());
      const sink = newSink(sameReference);
      const result = run({ ledger, principal, sink, idempotency });
      await flush(client, sink);
      await saveNewCommands(client, idempotency, knownCommands);
      return result;
    });
  }

  async function execute<T>(...args: Parameters<typeof once<T>>): Promise<T> {
    // 같은 멱등 키가 동시에 들어오면 한쪽의 저장이 유일 제약에 걸린다. 한 번 다시 시도하면 먼저 저장된 결과를 본다
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(...args);
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        const e = error as { code?: string; constraint?: string; message?: string };
        // DB 가드·유일 제약이 거부했다면 도메인 검사와 DB 상태가 어긋난 것(주로 동시 경쟁)이다. 업무 규칙 위반으로 돌려준다
        if (e.code === "P0001") throw new AppError("BUSINESS_INVARIANT", e.message);
        if (e.code === "23505") throw new AppError("BUSINESS_INVARIANT", "a concurrent request already recorded this");
        throw error;
      }
    }
  }

  /** 도메인 저장소를 만들고 새 기록만 `saved`에 모은다 */
  function repos(ctx: { ledger: PaymentLedger | undefined; sink: Sink; idempotency: Awaited<ReturnType<typeof loadCommands>> }) {
    const l = ctx.ledger;
    const s = ctx.sink;
    const forbidden = () => {
      throw new Error("this command must not write this ledger");
    };
    return {
      orders: {
        get: (t: string, id: string) => (l && l.order.tenantId === t && l.order.id === id ? l.order : undefined),
        list: () => (l ? [l.order] : []),
        save: forbidden,
      },
      payments: {
        get: (_t: string, id: string) => l?.payments.find((p) => p.id === id),
        list: (_t: string, orderId: string) => (l?.payments ?? []).filter((p) => p.orderId === orderId),
        listByTenant: () => [...(l?.payments ?? []), ...s.sameReference],
        save: (p: Payment) => void s.payments.push(p),
      },
      paymentConfirmations: {
        list: (_t: string, paymentId: string) => (l?.confirmations ?? []).filter((c) => c.paymentId === paymentId),
        save: (c: PaymentConfirmation) => void s.confirmations.push(c),
      },
      paymentVoids: {
        list: (_t: string, paymentId: string) => (l?.voids ?? []).filter((v) => v.paymentId === paymentId),
        save: (v: PaymentVoid) => void s.voids.push(v),
      },
      paymentCorrections: {
        get: (_t: string, id: string) => l?.corrections.find((c) => c.id === id),
        list: (_t: string, paymentId: string) => (l?.corrections ?? []).filter((c) => c.paymentId === paymentId),
        listByOrder: (_t: string, orderId: string) => (l?.corrections ?? []).filter((c) => c.orderId === orderId),
        save: (c: PaymentCorrection) => void s.corrections.push(c),
      },
      refundTasks: {
        get: (_t: string, id: string) => l?.tasks.find((r) => r.id === id),
        list: (_t: string, orderId: string) => (l?.tasks ?? []).filter((r) => r.orderId === orderId),
        save: (r: RefundTask) => void s.tasks.push(r),
      },
      refundConfirmations: {
        list: (_t: string, taskId: string) => (l?.refunds ?? []).filter((r) => r.refundTaskId === taskId),
        listByOrder: (_t: string, orderId: string) => (l?.refunds ?? []).filter((r) => r.orderId === orderId),
        listByPayment: (_t: string, paymentId: string) => (l?.refunds ?? []).filter((r) => r.paymentId === paymentId),
        save: (r: RefundConfirmation) => void s.refunds.push(r),
      },
      refundRequests: {
        get: (_t: string, id: string) => l?.requests.find((r) => r.id === id),
        list: (_t: string, taskId: string) => (l?.requests ?? []).filter((r) => r.refundTaskId === taskId),
        save: (r: RefundRequest) => void s.requests.push(r),
      },
      refundRequestDecisions: {
        list: (_t: string, requestId: string) => (l?.decisions ?? []).filter((d) => d.requestId === requestId),
        save: (d: RefundRequestDecision) => void s.decisions.push(d),
      },
      refundAttempts: { list: (_t: string, taskId: string) => (l?.attempts ?? []).filter((a) => a.refundTaskId === taskId) },
      refundAttemptResolutions: { list: (_t: string, attemptId: string) => (l?.resolutions ?? []).filter((r) => r.attemptId === attemptId) },
      idempotency: ctx.idempotency,
    };
  }

  return {
    recordPayment: (actor: Actor, request: RecordPaymentBody): Promise<Payment> =>
      execute(actor, request, { orderId: request.orderId }, { externalReference: request.externalReference }, (ctx) => {
        const { tenantId: _t, ...rest } = request;
        void _t;
        return authorizedActions.recordPayment(repos(ctx), ctx.principal, rest);
      }),
    confirmPayment: (actor: Actor, request: ConfirmPaymentBody): Promise<PaymentConfirmation> =>
      execute(actor, request, { table: "ordering_payments", id: request.paymentId }, {}, (ctx) => {
        const { tenantId: _t, ...rest } = request;
        void _t;
        return authorizedActions.confirmPayment(repos(ctx), ctx.principal, rest);
      }),
    voidPayment: (actor: Actor, request: VoidPaymentBody): Promise<PaymentVoid> =>
      execute(actor, request, { table: "ordering_payments", id: request.paymentId }, {}, (ctx) => {
        const { tenantId: _t, ...rest } = request;
        void _t;
        return authorizedActions.voidPayment(repos(ctx), ctx.principal, rest);
      }),
    correctPayment: (actor: Actor, request: CorrectPaymentBody): Promise<PaymentCorrection> =>
      execute(actor, request, { table: "ordering_payments", id: request.paymentId }, {}, (ctx) => {
        const { tenantId: _t, ...rest } = request;
        void _t;
        return authorizedActions.correctPayment(repos(ctx), ctx.principal, rest);
      }),
    openRefundTask: (actor: Actor, request: OpenRefundTaskBody): Promise<RefundTask> =>
      execute(actor, request, { orderId: request.orderId }, {}, (ctx) => {
        const { tenantId: _t, ...rest } = request;
        void _t;
        return authorizedActions.openRefundTask(repos(ctx), ctx.principal, rest);
      }),
    requestRefund: (actor: Actor, request: RequestRefundBody): Promise<RefundRequest> =>
      execute(actor, request, { table: "ordering_refund_tasks", id: request.refundTaskId }, {}, (ctx) => {
        const { tenantId: _t, ...rest } = request;
        void _t;
        return authorizedActions.requestRefund(repos(ctx), ctx.principal, rest);
      }),
    decideRefundRequest: (actor: Actor, request: DecideRefundRequestBody): Promise<DecideRefundRequestResult> =>
      execute(actor, request, { table: "ordering_refund_requests", id: request.requestId }, {}, (ctx) => {
        const { tenantId: _t, ...rest } = request;
        void _t;
        return authorizedActions.decideRefundRequest(repos(ctx), ctx.principal, rest);
      }),
  };
}

type Sink = {
  sameReference: Payment[];
  payments: Payment[];
  confirmations: PaymentConfirmation[];
  tasks: RefundTask[];
  requests: RefundRequest[];
  decisions: RefundRequestDecision[];
  refunds: RefundConfirmation[];
  corrections: PaymentCorrection[];
  voids: PaymentVoid[];
};
const newSink = (sameReference: Payment[]): Sink => ({ sameReference, payments: [], confirmations: [], tasks: [], requests: [], decisions: [], refunds: [], corrections: [], voids: [] });

/** 도메인이 새로 만든 기록을 저장한다. 같은 요청에서 결정 → 원장 순서가 지켜지도록 참조되는 쪽을 먼저 넣는다 */
async function flush(client: PoolClient, s: Sink): Promise<void> {
  for (const p of s.payments) {
    await client.query(
      "insert into public.ordering_payments (id, tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [p.id, p.tenantId, p.orderId, p.method, p.amountKrw, p.externalReference, p.paidAt, p.recordedBy, p.recordedAt],
    );
  }
  for (const c of s.confirmations) {
    await client.query(
      "insert into public.ordering_payment_confirmations (id, tenant_id, payment_id, evidence, confirmed_by, confirmed_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [c.id, c.tenantId, c.paymentId, c.evidence, c.confirmedBy, c.confirmedAt, c.recordedAt],
    );
  }
  for (const v of s.voids) {
    await client.query("insert into public.ordering_payment_voids (id, tenant_id, payment_id, reason, voided_by, voided_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)", [v.id, v.tenantId, v.paymentId, v.reason, v.voidedBy, v.voidedAt, v.recordedAt]);
  }
  for (const c of s.corrections) {
    await client.query(
      "insert into public.ordering_payment_corrections (id, tenant_id, order_id, payment_id, reduced_krw, reason, evidence, corrected_by, corrected_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [c.id, c.tenantId, c.orderId, c.paymentId, c.reducedKrw, c.reason, c.evidence, c.correctedBy, c.correctedAt, c.recordedAt],
    );
  }
  for (const t of s.tasks) {
    await client.query(
      "insert into public.ordering_refund_tasks (id, tenant_id, order_id, required_krw, opened_by, opened_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [t.id, t.tenantId, t.orderId, t.requiredKrw, t.openedBy, t.openedAt, t.recordedAt],
    );
  }
  for (const r of s.requests) {
    await client.query(
      "insert into public.ordering_refund_requests (id, tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, requested_by, requested_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [r.id, r.tenantId, r.refundTaskId, r.orderId, r.paymentId, r.amountKrw, r.evidence, r.requestedBy, r.requestedAt, r.recordedAt],
    );
  }
  // 환급 원장은 결정보다 먼저 넣는다: 같은 요청을 동시에 승인하면 요청 하나당 원장 한 줄 제약이 먼저 막는다
  for (const r of s.refunds) {
    await client.query(
      "insert into public.ordering_refund_confirmations (id, tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, confirmed_by, confirmed_at, refund_request_id, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [r.id, r.tenantId, r.refundTaskId, r.orderId, r.paymentId, r.amountKrw, r.evidence, r.confirmedBy, r.confirmedAt, r.refundRequestId ?? null, r.recordedAt],
    );
  }
  for (const d of s.decisions) {
    await client.query(
      "insert into public.ordering_refund_request_decisions (id, tenant_id, request_id, kind, decided_by, decided_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [d.id, d.tenantId, d.requestId, d.kind, d.decidedBy, d.decidedAt, d.recordedAt],
    );
  }
}
