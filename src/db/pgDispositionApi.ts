import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import { AppError } from "../errors/AppError";
import type { AllocationCancellation } from "../inventory/cancelAllocation";
import type { StockMovement } from "../inventory/registerInitialStock";
import type { ReturnException } from "../inventory/reportReturnException";
import type { ReturnRequest, RequestReturnRequest } from "../inventory/requestReturn";
import type { ReturnExceptionResolution } from "../inventory/resolveReturnException";
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

export type TransferCancelledToStockBody = Omit<TransferCancelledToStockRequest, "actorRole" | "actedBy">;

export type RequestReturnBody = Omit<RequestReturnRequest, "actorRole" | "requestedBy">;

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

/** 주문 취소로 풀린 입고 배분 물량(취소 물량)의 처분 명령을 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 락 순서: 주문 행(공유) → 주문 인도 락('ful:') → 책 락. 같은 취소 물량의 동시 처분은 DB 트리거가 한 번 더 막는다. */
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

  /** 취소 물량 하나와 그 처분 기록을 적재한다. 처분 명령은 이 취소 물량의 주문을 먼저 잠근다 */
  async function loadCancellation(client: PoolClient, tenantId: string, cancellationId: unknown) {
    if (!isUuid(tenantId) || !isUuid(cancellationId)) return undefined;
    const row = (await client.query("select * from public.ordering_allocation_cancellations where tenant_id = $1 and id = $2", [tenantId, cancellationId])).rows[0];
    if (!row) return undefined;
    await client.query("select 1 from public.ordering_orders where tenant_id = $1 and id = $2 for share", [tenantId, row.order_id]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ful:${tenantId}:${row.order_id}`]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenantId}:${row.book_key}`]);
    return toCancellation(row);
  }


  /** 이 취소 물량의 처분 기록 전체(편입·반품 요청·예외·해소)와 책의 수불 원장 */
  async function loadDisposition(client: PoolClient, cancellation: AllocationCancellation) {
    const t = cancellation.tenantId;
    const intakes = (await client.query("select * from public.ordering_stock_intakes where tenant_id = $1 and cancellation_id = $2", [t, cancellation.id])).rows.map(
      (i): StockIntake => ({ id: i.id, tenantId: i.tenant_id, bookId: cancellation.bookId, cancellationId: i.cancellation_id, receiptId: cancellation.receiptId, orderId: cancellation.orderId, orderLineId: cancellation.orderLineId, quantity: i.quantity, actedBy: i.acted_by, actedAt: iso(i.acted_at), recordedAt: iso(i.recorded_at) }),
    );
    const supplierCode = (
      await client.query(
        "select p.supplier_code from public.ordering_goods_receipts g join public.ordering_purchase_orders p on p.tenant_id = g.tenant_id and p.id = g.purchase_order_id where g.tenant_id = $1 and g.id = $2",
        [t, cancellation.receiptId],
      )
    ).rows[0]?.supplier_code as string | undefined;
    const returnRequests = (await client.query("select * from public.ordering_return_requests where tenant_id = $1 and cancellation_id = $2", [t, cancellation.id])).rows.map(
      (r): ReturnRequest => ({ id: r.id, tenantId: r.tenant_id, bookId: cancellation.bookId, cancellationId: r.cancellation_id, receiptId: cancellation.receiptId, supplierCode: supplierCode ?? "", quantity: r.quantity, requestedBy: r.requested_by, requestedAt: iso(r.requested_at), recordedAt: iso(r.recorded_at) }),
    );
    const requestIds = returnRequests.map((r) => r.id);
    const exceptions = (await client.query("select * from public.ordering_return_exceptions where tenant_id = $1 and return_request_id = any($2::uuid[])", [t, requestIds])).rows.map(
      (e): ReturnException => ({ id: e.id, tenantId: e.tenant_id, returnRequestId: e.return_request_id, quantity: e.quantity, kind: e.kind, evidence: "", reportedBy: e.reported_by, reportedAt: iso(e.reported_at), recordedAt: iso(e.recorded_at) }),
    );
    const resolutions = (await client.query("select * from public.ordering_return_exception_resolutions where tenant_id = $1 and return_exception_id = any($2::uuid[])", [t, exceptions.map((e) => e.id)])).rows.map(
      (r): ReturnExceptionResolution => ({ id: r.id, tenantId: r.tenant_id, returnExceptionId: r.return_exception_id, returnRequestId: exceptions.find((e) => e.id === r.return_exception_id)?.returnRequestId ?? "", outcome: r.outcome, quantity: r.quantity, evidence: "", resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at), recordedAt: iso(r.recorded_at) }),
    );
    const { movements } = await loadBookLedger(client, t, cancellation.bookId);
    return { intakes, returnRequests, exceptions, resolutions, movements };
  }
  type Disposition = Awaited<ReturnType<typeof loadDisposition>>;
  const emptyDisposition: Disposition = { intakes: [], returnRequests: [], exceptions: [], resolutions: [], movements: [] };
  /** 처분 대기 잔량 계산이 읽는 저장소들. 공급처 회신(반품 거절)은 아직 영속화하지 않아 비어 있다 */
  const pendingDeps = (state: Disposition) => ({
    returnRequests: { list: (_t: string, id: string) => state.returnRequests.filter((r) => r.cancellationId === id) },
    returnReplies: { list: () => [] },
    returnExceptions: { list: (_t: string, id: string) => state.exceptions.filter((e) => e.returnRequestId === id) },
    returnExceptionResolutions: { list: (_t: string, id: string) => state.resolutions.filter((r) => r.returnExceptionId === id) },
  });

  const transferOnce = (actor: Actor, request: TransferCancelledToStockBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const cancellation = await loadCancellation(client, request.tenantId, request.cancellationId);
      const state = cancellation ? await loadDisposition(client, cancellation) : emptyDisposition;
      const { intakes, movements } = state;
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const savedIntakes: StockIntake[] = [];
      const savedMovements: StockMovement[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.transferCancelledToStock(
        {
          allocationCancellations: { get: (_t2, id) => (cancellation && cancellation.id === id ? cancellation : undefined) },
          stockIntakes: { list: (_t2, id) => intakes.filter((i) => i.cancellationId === id), save: (i) => void savedIntakes.push(i) },
          ...pendingDeps(state),
          stockMovements: { list: () => movements, save: (m) => void savedMovements.push(m) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const i of savedIntakes) {
        await client.query("insert into public.ordering_stock_intakes (id, tenant_id, cancellation_id, quantity, acted_by, acted_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)", [i.id, i.tenantId, i.cancellationId, i.quantity, i.actedBy, i.actedAt, i.recordedAt]);
      }
      for (const m of savedMovements) {
        await client.query(
          "insert into public.ordering_stock_movements (id, tenant_id, book_key, kind, direction, quantity, reason, cancellation_id, acted_by, acted_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [m.id, m.tenantId, m.bookId, m.kind, m.direction, m.quantity, m.reason, m.cancellationId ?? null, m.actedBy, m.actedAt, m.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const requestReturnOnce = (actor: Actor, request: RequestReturnBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const cancellation = await loadCancellation(client, request.tenantId, request.cancellationId);
      const state = cancellation ? await loadDisposition(client, cancellation) : emptyDisposition;
      const poId = cancellation
        ? ((await client.query("select purchase_order_id from public.ordering_goods_receipts where tenant_id = $1 and id = $2", [cancellation.tenantId, cancellation.receiptId])).rows[0]?.purchase_order_id as string | undefined)
        : undefined;
      const po = poId && cancellation ? await loadPoState(client, cancellation.tenantId, poId) : undefined;
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: ReturnRequest[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.requestReturn(
        {
          allocationCancellations: { get: (_t2, id) => (cancellation && cancellation.id === id ? cancellation : undefined) },
          receipts: { get: (_t2, id) => po?.receipts.find((r) => r.id === id), list: () => po?.receipts ?? [], save: forbidden },
          purchaseOrders: { get: (_t2, id) => (po?.po && po.po.id === id ? po.po : undefined), list: () => (po?.po ? [po.po] : []), save: forbidden },
          stockIntakes: { list: (_t2, id) => state.intakes.filter((i) => i.cancellationId === id) },
          ...pendingDeps(state),
          returnRequests: { get: (_t2, id) => state.returnRequests.find((r) => r.id === id), list: (_t2, id) => state.returnRequests.filter((r) => r.cancellationId === id), save: (r) => void saved.push(r) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const r of saved) {
        await client.query("insert into public.ordering_return_requests (id, tenant_id, cancellation_id, quantity, requested_by, requested_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)", [r.id, r.tenantId, r.cancellationId, r.quantity, r.requestedBy, r.requestedAt, r.recordedAt]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  void forbidden;
  return {
    requestReturn: (actor: Actor, request: RequestReturnBody) => withRetry(() => requestReturnOnce(actor, request)),
    transferCancelledToStock: (actor: Actor, request: TransferCancelledToStockBody) => withRetry(() => transferOnce(actor, request)),
  };
}
