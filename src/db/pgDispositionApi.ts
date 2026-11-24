import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { UserPrincipal } from "../auth/principal";
import { AppError } from "../errors/AppError";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import type { AllocationCancellation } from "../inventory/cancelAllocation";
import type { CompleteReturnRequest, ReturnCompletion } from "../inventory/completeReturn";
import type { DispatchReturnRequest, ReturnDispatch } from "../inventory/dispatchReturn";
import type { RecordReturnReplyRequest, ReturnReply } from "../inventory/recordReturnReply";
import type { StockMovement } from "../inventory/registerInitialStock";
import type { RenegotiateReturnRequest } from "../inventory/renegotiateReturn";
import type { ReportReturnExceptionRequest, ReturnException } from "../inventory/reportReturnException";
import type { RequestReturnRequest, ReturnRequest } from "../inventory/requestReturn";
import type { ResolveReturnExceptionRequest, ReturnExceptionResolution } from "../inventory/resolveReturnException";
import type { StockIntake, TransferCancelledToStockRequest } from "../inventory/transferCancelledToStock";
import { loadPoState } from "./pgReceivingApi";
import { loadBookLedger } from "./pgStockApi";
import {
  inTransaction,
  isCommandKeyConflict,
  isUuid,
  loadCommands,
  loadMembership,
  principalFor,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";

type Actor = { userId: string };
const iso = (value: Date) => value.toISOString();
const forbidden = () => {
  throw new Error("this command must not write this ledger");
};

/** 호출자가 보내는 요청. 행위자(역할·이름)는 인증된 사용자에서 주입되므로 보낼 필요가 없다 */
export type TransferCancelledToStockBody = Omit<TransferCancelledToStockRequest, "actorRole" | "actedBy">;
export type RequestReturnBody = Omit<RequestReturnRequest, "actorRole" | "requestedBy">;
export type RecordReturnReplyBody = Omit<RecordReturnReplyRequest, "repliedBy">;
export type DispatchReturnBody = Omit<DispatchReturnRequest, "dispatchedBy">;
export type CompleteReturnBody = Omit<CompleteReturnRequest, "confirmedBy">;
export type ReportReturnExceptionBody = Omit<ReportReturnExceptionRequest, "reportedBy">;
export type ResolveReturnExceptionBody = Omit<ResolveReturnExceptionRequest, "resolvedBy">;
export type RenegotiateReturnBody = Omit<RenegotiateReturnRequest, "requestedBy">;

const toCancellation = (c: any): AllocationCancellation => ({
  id: c.id,
  tenantId: c.tenant_id,
  bookId: c.book_key,
  receiptId: c.receipt_id,
  allocationId: c.allocation_id,
  orderId: c.order_id,
  orderLineId: c.order_line_id,
  quantity: c.quantity,
  reason: c.reason,
  cancelledBy: c.cancelled_by,
  cancelledAt: iso(c.cancelled_at),
  recordedAt: iso(c.recorded_at),
});

/** 명령이 가리키는 대상에서 취소 물량을 찾는 방법 */
type Source = { kind: "cancellation" | "request" | "exception"; id: unknown };

/** 새로 저장할 기록 */
type Sink = {
  intakes: StockIntake[];
  movements: StockMovement[];
  requests: ReturnRequest[];
  replies: ReturnReply[];
  dispatches: ReturnDispatch[];
  completions: ReturnCompletion[];
  exceptions: ReturnException[];
  resolutions: ReturnExceptionResolution[];
};

/** 주문 취소로 풀린 입고 배분 물량(취소 물량)의 처분 명령(재고 편입·반품 요청·회신·출고·완료·예외·해소·재협의)을
 * Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 락 순서: 주문 행(공유) → 주문 인도 락('ful:') → 책 락 → (DB 트리거) 취소 물량 락('dsp:'). 같은 취소 물량의 처분은 모두 직렬화된다. */
export function createPgDispositionApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        if ((error as { code?: string }).code === "P0001") throw new AppError("BUSINESS_INVARIANT", (error as Error).message);
        throw error;
      }
    }
  };

  async function cancellationIdOf(client: PoolClient, tenantId: string, source: Source): Promise<string | undefined> {
    if (!isUuid(tenantId) || !isUuid(source.id)) return undefined;
    if (source.kind === "cancellation") return source.id;
    const sql =
      source.kind === "request"
        ? "select cancellation_id from public.ordering_return_requests where tenant_id = $1 and id = $2"
        : "select q.cancellation_id from public.ordering_return_exceptions e join public.ordering_return_requests q on q.tenant_id = e.tenant_id and q.id = e.return_request_id where e.tenant_id = $1 and e.id = $2";
    return (await client.query(sql, [tenantId, source.id])).rows[0]?.cancellation_id as string | undefined;
  }

  /** 취소 물량 하나를 적재하고 그 주문·책을 잠근다 */
  async function loadCancellation(client: PoolClient, tenantId: string, cancellationId: string | undefined) {
    if (!cancellationId) return undefined;
    const row = (await client.query("select * from public.ordering_allocation_cancellations where tenant_id = $1 and id = $2", [tenantId, cancellationId])).rows[0];
    if (!row) return undefined;
    await client.query("select 1 from public.ordering_orders where tenant_id = $1 and id = $2 for share", [tenantId, row.order_id]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ful:${tenantId}:${row.order_id}`]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenantId}:${row.book_key}`]);
    return toCancellation(row);
  }

  /** 이 취소 물량의 처분 기록 전체와 책의 수불 원장, 원 입고의 발주 상태 */
  async function loadState(client: PoolClient, cancellation: AllocationCancellation) {
    const t = cancellation.tenantId;
    const all = async (table: string, column: string, ids: string[]) => (await client.query(`select * from public.${table} where tenant_id = $1 and ${column} = any($2::uuid[]) order by recorded_at, id`, [t, ids])).rows;
    const intakes = (await all("ordering_stock_intakes", "cancellation_id", [cancellation.id])).map(
      (i): StockIntake => ({ id: i.id, tenantId: i.tenant_id, bookId: cancellation.bookId, cancellationId: i.cancellation_id, receiptId: cancellation.receiptId, orderId: cancellation.orderId, orderLineId: cancellation.orderLineId, quantity: i.quantity, actedBy: i.acted_by, actedAt: iso(i.acted_at), recordedAt: iso(i.recorded_at) }),
    );
    const receiptRow = (await client.query("select purchase_order_id from public.ordering_goods_receipts where tenant_id = $1 and id = $2", [t, cancellation.receiptId])).rows[0];
    const po = receiptRow ? await loadPoState(client, t, receiptRow.purchase_order_id) : undefined;
    const requests = (await all("ordering_return_requests", "cancellation_id", [cancellation.id])).map(
      (r): ReturnRequest => ({
        id: r.id,
        tenantId: r.tenant_id,
        bookId: cancellation.bookId,
        cancellationId: r.cancellation_id,
        receiptId: cancellation.receiptId,
        supplierCode: po?.po?.supplierCode ?? "",
        quantity: r.quantity,
        requestedBy: r.requested_by,
        requestedAt: iso(r.requested_at),
        ...(r.retry_of_request_id === null ? {} : { retryOfRequestId: r.retry_of_request_id, retryReason: r.retry_reason }),
        recordedAt: iso(r.recorded_at),
      }),
    );
    const requestIds = requests.map((r) => r.id);
    const replies = (await all("ordering_return_replies", "return_request_id", requestIds)).map(
      (r): ReturnReply => ({ id: r.id, tenantId: r.tenant_id, returnRequestId: r.return_request_id, acceptedQuantity: r.accepted_quantity, rejectedQuantity: r.rejected_quantity, evidence: r.evidence, repliedBy: r.replied_by, repliedAt: iso(r.replied_at), recordedAt: iso(r.recorded_at) }),
    );
    const dispatches = (await all("ordering_return_dispatches", "return_request_id", requestIds)).map(
      (d): ReturnDispatch => ({ id: d.id, tenantId: d.tenant_id, returnRequestId: d.return_request_id, quantity: d.quantity, dispatchedBy: d.dispatched_by, dispatchedAt: iso(d.dispatched_at), ...(d.reference_number === null ? {} : { referenceNumber: d.reference_number }), recordedAt: iso(d.recorded_at) }),
    );
    const completions = (await all("ordering_return_completions", "return_request_id", requestIds)).map(
      (c): ReturnCompletion => ({ id: c.id, tenantId: c.tenant_id, returnRequestId: c.return_request_id, quantity: c.quantity, evidence: c.evidence, confirmedBy: c.confirmed_by, confirmedAt: iso(c.confirmed_at), recordedAt: iso(c.recorded_at) }),
    );
    const exceptions = (await all("ordering_return_exceptions", "return_request_id", requestIds)).map(
      (e): ReturnException => ({ id: e.id, tenantId: e.tenant_id, returnRequestId: e.return_request_id, quantity: e.quantity, kind: e.kind, evidence: e.evidence, reportedBy: e.reported_by, reportedAt: iso(e.reported_at), recordedAt: iso(e.recorded_at) }),
    );
    const resolutions = (await all("ordering_return_exception_resolutions", "return_exception_id", exceptions.map((e) => e.id))).map(
      (r): ReturnExceptionResolution => ({ id: r.id, tenantId: r.tenant_id, returnExceptionId: r.return_exception_id, returnRequestId: exceptions.find((e) => e.id === r.return_exception_id)?.returnRequestId ?? "", outcome: r.outcome, quantity: r.quantity, evidence: r.evidence, resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at), recordedAt: iso(r.recorded_at) }),
    );
    const { movements } = await loadBookLedger(client, t, cancellation.bookId);
    return { intakes, movements, requests, replies, dispatches, completions, exceptions, resolutions, po };
  }
  type State = Awaited<ReturnType<typeof loadState>>;
  const emptyState: State = { intakes: [], movements: [], requests: [], replies: [], dispatches: [], completions: [], exceptions: [], resolutions: [], po: undefined };

  /** 모든 처분 명령이 읽고 쓰는 저장소의 상위 집합. 각 도메인 함수는 자기가 쓰는 부분만 사용한다 */
  function buildDeps(cancellation: AllocationCancellation | undefined, state: State, sink: Sink, idempotency: IdempotencyStore) {
    const byRequest = <T extends { returnRequestId: string }>(items: T[]) => (_t: string, id: string) => items.filter((i) => i.returnRequestId === id);
    return {
      allocationCancellations: { get: (_t: string, id: string) => (cancellation && cancellation.id === id ? cancellation : undefined) },
      receipts: { get: (_t: string, id: string) => state.po?.receipts.find((r) => r.id === id), list: () => state.po?.receipts ?? [], save: forbidden },
      purchaseOrders: { get: (_t: string, id: string) => (state.po?.po && state.po.po.id === id ? state.po.po : undefined), list: () => (state.po?.po ? [state.po.po] : []), save: forbidden },
      stockIntakes: { list: (_t: string, id: string) => state.intakes.filter((i) => i.cancellationId === id), save: (i: StockIntake) => void sink.intakes.push(i) },
      stockMovements: { list: () => state.movements, save: (m: StockMovement) => void sink.movements.push(m) },
      returnRequests: { get: (_t: string, id: string) => state.requests.find((r) => r.id === id), list: (_t: string, id: string) => state.requests.filter((r) => r.cancellationId === id), save: (r: ReturnRequest) => void sink.requests.push(r) },
      returnReplies: { list: byRequest(state.replies), save: (r: ReturnReply) => void sink.replies.push(r) },
      returnDispatches: { list: byRequest(state.dispatches), save: (d: ReturnDispatch) => void sink.dispatches.push(d) },
      returnCompletions: { list: byRequest(state.completions), save: (c: ReturnCompletion) => void sink.completions.push(c) },
      returnExceptions: { get: (_t: string, id: string) => state.exceptions.find((e) => e.id === id), list: byRequest(state.exceptions), save: (e: ReturnException) => void sink.exceptions.push(e) },
      returnExceptionResolutions: { list: (_t: string, id: string) => state.resolutions.filter((r) => r.returnExceptionId === id), save: (r: ReturnExceptionResolution) => void sink.resolutions.push(r) },
      idempotency,
    };
  }
  type Deps = ReturnType<typeof buildDeps>;

  async function persist(client: PoolClient, sink: Sink) {
    for (const r of sink.requests) {
      await client.query(
        "insert into public.ordering_return_requests (id, tenant_id, cancellation_id, quantity, requested_by, requested_at, retry_of_request_id, retry_reason, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [r.id, r.tenantId, r.cancellationId, r.quantity, r.requestedBy, r.requestedAt, r.retryOfRequestId ?? null, r.retryReason ?? null, r.recordedAt],
      );
    }
    for (const i of sink.intakes) {
      await client.query("insert into public.ordering_stock_intakes (id, tenant_id, cancellation_id, quantity, acted_by, acted_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)", [i.id, i.tenantId, i.cancellationId, i.quantity, i.actedBy, i.actedAt, i.recordedAt]);
    }
    for (const m of sink.movements) {
      await client.query(
        "insert into public.ordering_stock_movements (id, tenant_id, book_key, kind, direction, quantity, reason, cancellation_id, acted_by, acted_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [m.id, m.tenantId, m.bookId, m.kind, m.direction, m.quantity, m.reason, m.cancellationId ?? null, m.actedBy, m.actedAt, m.recordedAt],
      );
    }
    for (const r of sink.replies) {
      await client.query("insert into public.ordering_return_replies (id, tenant_id, return_request_id, accepted_quantity, rejected_quantity, evidence, replied_by, replied_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [r.id, r.tenantId, r.returnRequestId, r.acceptedQuantity, r.rejectedQuantity, r.evidence, r.repliedBy, r.repliedAt, r.recordedAt]);
    }
    for (const d of sink.dispatches) {
      await client.query("insert into public.ordering_return_dispatches (id, tenant_id, return_request_id, quantity, dispatched_by, dispatched_at, reference_number, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [d.id, d.tenantId, d.returnRequestId, d.quantity, d.dispatchedBy, d.dispatchedAt, d.referenceNumber ?? null, d.recordedAt]);
    }
    for (const c of sink.completions) {
      await client.query("insert into public.ordering_return_completions (id, tenant_id, return_request_id, quantity, evidence, confirmed_by, confirmed_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [c.id, c.tenantId, c.returnRequestId, c.quantity, c.evidence, c.confirmedBy, c.confirmedAt, c.recordedAt]);
    }
    for (const e of sink.exceptions) {
      await client.query("insert into public.ordering_return_exceptions (id, tenant_id, return_request_id, quantity, kind, evidence, reported_by, reported_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [e.id, e.tenantId, e.returnRequestId, e.quantity, e.kind, e.evidence, e.reportedBy, e.reportedAt, e.recordedAt]);
    }
    for (const r of sink.resolutions) {
      await client.query("insert into public.ordering_return_exception_resolutions (id, tenant_id, return_exception_id, outcome, quantity, evidence, resolved_by, resolved_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [r.id, r.tenantId, r.returnExceptionId, r.outcome, r.quantity, r.evidence, r.resolvedBy, r.resolvedAt, r.recordedAt]);
    }
  }

  /** 처분 명령 하나를 한 트랜잭션에서 실행한다: 잠금 → 적재 → 도메인 실행 → 새 기록 저장 */
  const execute = <B extends { tenantId: string; idempotencyKey: string }, R>(
    actor: Actor,
    body: B,
    source: Source,
    run: (deps: Deps, principal: UserPrincipal, rest: Omit<B, "tenantId">) => R,
  ): Promise<R> =>
    withRetry(() =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
        const cancellation = await loadCancellation(client, body.tenantId, await cancellationIdOf(client, body.tenantId, source));
        const state = cancellation ? await loadState(client, cancellation) : emptyState;
        const idempotency = await loadCommands(client, body.tenantId, body.idempotencyKey);
        const known = new Set(idempotency.keys());
        const sink: Sink = { intakes: [], movements: [], requests: [], replies: [], dispatches: [], completions: [], exceptions: [], resolutions: [] };
        const { tenantId: _t, ...rest } = body;
        void _t;
        const result = run(buildDeps(cancellation, state, sink, idempotency), principal, rest);
        await persist(client, sink);
        await saveNewCommands(client, idempotency, known);
        return result;
      }),
    );

  return {
    transferCancelledToStock: (actor: Actor, body: TransferCancelledToStockBody) =>
      execute(actor, body, { kind: "cancellation", id: body.cancellationId }, (d, p, rest) => authorizedActions.transferCancelledToStock(d, p, rest)),
    requestReturn: (actor: Actor, body: RequestReturnBody) =>
      execute(actor, body, { kind: "cancellation", id: body.cancellationId }, (d, p, rest) => authorizedActions.requestReturn(d, p, rest)),
    recordReturnReply: (actor: Actor, body: RecordReturnReplyBody) =>
      execute(actor, body, { kind: "request", id: body.returnRequestId }, (d, p, rest) => authorizedActions.recordReturnReply(d, p, rest)),
    dispatchReturn: (actor: Actor, body: DispatchReturnBody) =>
      execute(actor, body, { kind: "request", id: body.returnRequestId }, (d, p, rest) => authorizedActions.dispatchReturn(d, p, rest)),
    completeReturn: (actor: Actor, body: CompleteReturnBody) =>
      execute(actor, body, { kind: "request", id: body.returnRequestId }, (d, p, rest) => authorizedActions.completeReturn(d, p, rest)),
    reportReturnException: (actor: Actor, body: ReportReturnExceptionBody) =>
      execute(actor, body, { kind: "request", id: body.returnRequestId }, (d, p, rest) => authorizedActions.reportReturnException(d, p, rest)),
    resolveReturnException: (actor: Actor, body: ResolveReturnExceptionBody) =>
      execute(actor, body, { kind: "exception", id: body.returnExceptionId }, (d, p, rest) => authorizedActions.resolveReturnException(d, p, rest)),
    renegotiateReturn: (actor: Actor, body: RenegotiateReturnBody) =>
      execute(actor, body, { kind: "request", id: body.originalRequestId }, (d, p, rest) => authorizedActions.renegotiateReturn(d, p, rest)),
  };
}
