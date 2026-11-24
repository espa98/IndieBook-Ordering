import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import { createSystemPrincipal } from "../auth/principal";
import { AppError } from "../errors/AppError";
import type { Fulfillment } from "../fulfillment/postFulfillment";
import type { ReceiptAllocation } from "../inventory/allocateReceipt";
import type { AllocationCancellation } from "../inventory/cancelAllocation";
import type { ReturnCompletion } from "../inventory/completeReturn";
import type { AllocationDelivery } from "../inventory/deliverAllocation";
import type { StockMovement } from "../inventory/registerInitialStock";
import type { AllocationRelease } from "../inventory/releaseAllocation";
import type { StockReservationDelivery } from "../inventory/deliverStockReservation";
import type { StockReservationRelease } from "../inventory/releaseStockReservation";
import type { StockReservationRecord } from "../inventory/reserveStock";
import type { ReturnException } from "../inventory/reportReturnException";
import type { ReturnRequest } from "../inventory/requestReturn";
import type { ReturnExceptionResolution } from "../inventory/resolveReturnException";
import type { StockIntake } from "../inventory/transferCancelledToStock";
import type { Order } from "../order/createDraftOrder";
import type { ApplyOrderCancellationRequest } from "../order/applyOrderCancellation";
import type { DecideOrderCancellationRequest } from "../order/decideOrderCancellation";
import type { OrderClosure, ExecuteOrderClosureRequest } from "../order/executeOrderClosure";
import type { OrderClosureRequest, RequestOrderClosureRequest } from "../order/requestOrderClosure";
import type { OrderCancellationDecision, OrderCancellationRequest } from "../order/requestOrderCancellation";
import type { RefundTask } from "../payment/openRefundTask";
import { loadCancellations, loadFulfillments } from "./pgFulfillmentApi";
import { saveOrder } from "./pgOrderApi";
import { loadLedger } from "./pgPaymentApi";
import { loadPoState, polLockKey } from "./pgReceivingApi";
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
const forbidden = () => {
  throw new Error("this command must not write this ledger");
};

export type DecideOrderCancellationBody = Omit<DecideOrderCancellationRequest, "actorRole" | "decidedBy">;
export type ApplyOrderCancellationBody = Omit<ApplyOrderCancellationRequest, "actorRole" | "appliedBy">;
export type RequestOrderClosureBody = Omit<RequestOrderClosureRequest, "requestedBy">;
export type ExecuteOrderClosureBody = Omit<ExecuteOrderClosureRequest, "executedBy">;

const toClosureRequest = (r: any): OrderClosureRequest => ({
  id: r.id,
  tenantId: r.tenant_id,
  orderId: r.order_id,
  expectedVersion: Number(r.expected_version),
  requestedBy: r.requested_by,
  requestedAt: iso(r.requested_at),
  recordedAt: iso(r.recorded_at),
});
const toClosure = (c: any): OrderClosure => ({
  id: c.id,
  tenantId: c.tenant_id,
  orderId: c.order_id,
  closureRequestId: c.closure_request_id,
  orderVersionBefore: Number(c.order_version_before),
  orderVersionAfter: Number(c.order_version_after),
  executedBy: "SYSTEM",
  ...(c.outcome === null ? {} : { outcome: c.outcome }),
  closedAt: iso(c.closed_at),
  recordedAt: iso(c.recorded_at),
});

/** 주문 취소 결정·적용과 주문 종결 요청·실행을 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 취소 적용은 주문 행을 `FOR UPDATE`로 잡고(인도·예약·결제 어댑터의 공유 잠금과 배타), 주문 인도 락 → 책 락 → 발주 품목 락
 * 순서로 필요한 물량을 정리한다. 종결 실행은 서버(SYSTEM) 전용이며 처분(재고 편입·반품) 기록은 읽기만 한다. */
export function createPgCancellationApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    // 같은 멱등 키가 동시에 들어오면 한쪽의 저장이 유일 제약에 걸린다. 한 번 다시 시도하면 먼저 저장된 결과를 본다
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
  const lockFul = (client: PoolClient, order: Order) => client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ful:${order.tenantId}:${order.id}`]);
  const orderIdOfRequest = async (client: PoolClient, tenantId: string, requestId: unknown) =>
    isUuid(tenantId) && isUuid(requestId)
      ? ((await client.query("select order_id from public.ordering_order_cancellation_requests where tenant_id = $1 and id = $2", [tenantId, requestId])).rows[0]?.order_id as string | undefined)
      : undefined;

  const decideOnce = (actor: Actor, request: DecideOrderCancellationBody): Promise<OrderCancellationDecision> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const orderId = await orderIdOfRequest(client, request.tenantId, request.requestId);
      const [order] = orderId ? await loadOrders(client, request.tenantId, { orderId, lock: "share" }) : [];
      let requests: OrderCancellationRequest[] = [];
      let decisions: OrderCancellationDecision[] = [];
      if (order) {
        await lockFul(client, order);
        ({ requests, decisions } = await loadCancellations(client, order.tenantId, order.id));
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: OrderCancellationDecision[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.decideOrderCancellation(
        {
          orders: { get: (t, id) => (order && order.tenantId === t && order.id === id ? order : undefined), list: () => (order ? [order] : []), save: forbidden },
          orderCancellationRequests: { get: (_t2, id) => requests.find((r) => r.id === id), list: () => requests, save: forbidden },
          orderCancellationDecisions: { list: (_t2, requestId) => decisions.filter((d) => d.requestId === requestId), save: (d) => void saved.push(d) },
          idempotency,
        },
        principal,
        rest,
      );
      await insertDecisions(client, saved);
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const applyOnce = (actor: Actor, request: ApplyOrderCancellationBody): Promise<OrderCancellationDecision> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const orderId = await orderIdOfRequest(client, request.tenantId, request.requestId);
      const [order] = orderId ? await loadOrders(client, request.tenantId, { orderId, lock: "update" }) : [];

      let requests: OrderCancellationRequest[] = [];
      let decisions: OrderCancellationDecision[] = [];
      let fulfillments: Fulfillment[] = [];
      let reservations: StockReservationRecord[] = [];
      let resReleases: StockReservationRelease[] = [];
      let resDeliveries: StockReservationDelivery[] = [];
      let movements: StockMovement[] = [];
      let paymentLedger: Awaited<ReturnType<typeof loadLedger>> | undefined;
      const states: Awaited<ReturnType<typeof loadPoState>>[] = [];
      if (order) {
        await lockFul(client, order);
        ({ requests, decisions } = await loadCancellations(client, order.tenantId, order.id));
        const line = order.lines.find((l) => l.lineId === requests.find((r) => r.id === request.requestId)?.orderLineId);
        if (line) {
          // 책 락 → 발주 품목 락(정렬 순). 락을 잡은 뒤에 원장을 읽는다
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${order.tenantId}:${line.bookId}`]);
          const ledger = await loadBookLedger(client, order.tenantId, line.bookId);
          ({ reservations, releases: resReleases, deliveries: resDeliveries, movements } = ledger);
          const poRows = (
            await client.query(
              `select distinct g.purchase_order_id, g.po_line_id from public.ordering_receipt_allocations a
                 join public.ordering_goods_receipts g on g.tenant_id = a.tenant_id and g.id = a.receipt_id
                where a.tenant_id = $1 and a.order_id = $2 and a.order_line_id = $3 order by g.po_line_id`,
              [order.tenantId, order.id, line.lineId],
            )
          ).rows;
          for (const r of poRows) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [polLockKey(order.tenantId, r.po_line_id)]);
          for (const poId of [...new Set(poRows.map((r) => r.purchase_order_id as string))]) states.push(await loadPoState(client, order.tenantId, poId));
        }
        fulfillments = await loadFulfillments(client, order.tenantId, order.id);
        paymentLedger = await loadLedger(client, order);
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());

      const flat = <T>(pick: (s: (typeof states)[number]) => T[]) => states.flatMap(pick);
      const savedOrders: Order[] = [];
      const newDecisions: OrderCancellationDecision[] = [];
      const newReleases: StockReservationRelease[] = [];
      const newCancellations: AllocationCancellation[] = [];
      const newTasks: RefundTask[] = [];
      const pl = paymentLedger;
      const { tenantId: _t, ...rest } = request;
      void _t;
      const applyDeps: Parameters<typeof authorizedActions.applyOrderCancellation>[0] = {
        // 저장된 주문(줄어든 수량·합계)이 이후 환급 계산에 보이도록 최신 저장분을 우선한다
        orders: {
          get: (t, id) => {
            const current = savedOrders.at(-1) ?? order;
            return current && current.tenantId === t && current.id === id ? current : undefined;
          },
          list: () => {
            const current = savedOrders.at(-1) ?? order;
            return current ? [current] : [];
          },
          save: (o) => void savedOrders.push(o),
        },
        fulfillments: { list: () => fulfillments },
        orderCancellationRequests: { get: (_t2, id) => requests.find((r) => r.id === id), list: () => requests, save: forbidden },
        orderCancellationDecisions: { list: (_t2, requestId) => decisions.filter((d) => d.requestId === requestId), save: (d) => void newDecisions.push(d) },
        stockReservations: { get: (_t2, id) => reservations.find((r) => r.id === id), list: (_t2, bookId) => reservations.filter((r) => r.bookId === bookId), save: forbidden },
        stockReservationReleases: { list: (_t2, id) => resReleases.filter((r) => r.reservationId === id), save: (r) => void newReleases.push(r) },
        stockReservationDeliveries: { list: (_t2, id) => resDeliveries.filter((d) => d.reservationId === id) },
        receipts: { get: (_t2, id) => flat((s) => s.receipts).find((r) => r.id === id), list: (_t2, poId) => flat((s) => s.receipts).filter((r) => r.purchaseOrderId === poId), save: forbidden },
        purchaseOrders: { get: (_t2, id) => states.find((s) => s.po?.id === id)?.po, list: () => states.flatMap((s) => (s.po ? [s.po] : [])), save: forbidden },
        receiptAllocations: {
          get: (_t2, id) => flat((s) => s.allocations).find((a) => a.id === id),
          listByOrder: (_t2, oid) => flat((s) => s.allocations).filter((a) => a.orderId === oid),
          list: (_t2, receiptId) => flat((s) => s.allocations).filter((a) => a.receiptId === receiptId),
          save: forbidden,
        },
        allocationReleases: { list: (_t2, id) => flat((s) => s.releases).filter((r) => r.allocationId === id), save: forbidden },
        allocationDeliveries: { list: (_t2, id) => flat((s) => s.deliveries).filter((d) => d.allocationId === id), save: forbidden },
        allocationCancellations: {
          get: (_t2, id) => [...flat((s) => s.cancellations), ...newCancellations].find((c) => c.id === id),
          list: (_t2, id) => [...flat((s) => s.cancellations), ...newCancellations].filter((c) => c.allocationId === id),
          save: (c) => void newCancellations.push(c),
        },
        payments: { get: (_t2, id) => pl?.payments.find((p) => p.id === id), list: (_t2, oid) => (pl?.payments ?? []).filter((p) => p.orderId === oid), listByTenant: () => pl?.payments ?? [], save: forbidden },
        paymentConfirmations: { list: (_t2, id) => (pl?.confirmations ?? []).filter((c) => c.paymentId === id) },
        paymentVoids: { list: (_t2, id) => (pl?.voids ?? []).filter((v) => v.paymentId === id) },
        paymentCorrections: { listByOrder: (_t2, oid) => (pl?.corrections ?? []).filter((c) => c.orderId === oid) },
        refundTasks: {
          get: (_t2, id) => [...(pl?.tasks ?? []), ...newTasks].find((r) => r.id === id),
          list: (_t2, oid) => [...(pl?.tasks ?? []), ...newTasks].filter((r) => r.orderId === oid),
          save: (r) => void newTasks.push(r),
        },
        refundConfirmations: {
          list: (_t2, id) => (pl?.refunds ?? []).filter((r) => r.refundTaskId === id),
          listByOrder: (_t2, oid) => (pl?.refunds ?? []).filter((r) => r.orderId === oid),
        },
        idempotency,
      };
      void movements;
      const result = authorizedActions.applyOrderCancellation(applyDeps, principal, rest);

      // 주문(수량·합계·version) → 예약 해제 → 처분 대기 → 환급 업무 → 결정 순으로 저장한다
      for (const o of savedOrders) await saveOrder(client, o, order);
      for (const r of newReleases) {
        await client.query(
          "insert into public.ordering_stock_reservation_releases (id, tenant_id, reservation_id, quantity, reason, released_by, released_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [r.id, r.tenantId, r.reservationId, r.quantity, r.reason, r.releasedBy, r.releasedAt, r.recordedAt],
        );
      }
      for (const c of newCancellations) {
        await client.query(
          "insert into public.ordering_allocation_cancellations (id, tenant_id, book_key, receipt_id, allocation_id, order_id, order_line_id, quantity, reason, cancelled_by, cancelled_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
          [c.id, c.tenantId, c.bookId, c.receiptId, c.allocationId, c.orderId, c.orderLineId, c.quantity, c.reason, c.cancelledBy, c.cancelledAt, c.recordedAt],
        );
      }
      for (const t of newTasks) {
        await client.query(
          "insert into public.ordering_refund_tasks (id, tenant_id, order_id, required_krw, opened_by, opened_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)",
          [t.id, t.tenantId, t.orderId, t.requiredKrw, t.openedBy, t.openedAt, t.recordedAt],
        );
      }
      await insertDecisions(client, newDecisions);
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const requestClosureOnce = (actor: Actor, request: RequestOrderClosureBody): Promise<OrderClosureRequest> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const [order] = isUuid(request.orderId) ? await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: "share" }) : [];
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: OrderClosureRequest[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.requestOrderClosure(
        {
          orders: { get: (t, id) => (order && order.tenantId === t && order.id === id ? order : undefined), list: () => (order ? [order] : []), save: forbidden },
          closureRequests: { get: forbidden as never, list: () => [], save: (r) => void saved.push(r) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const r of saved) {
        await client.query(
          "insert into public.ordering_order_closure_requests (id, tenant_id, order_id, expected_version, requested_by, requested_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)",
          [r.id, r.tenantId, r.orderId, r.expectedVersion, r.requestedBy, r.requestedAt, r.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const executeClosureOnce = (request: ExecuteOrderClosureBody): Promise<OrderClosure> =>
    inTransaction(deps.pool, "service_role", "", async (client) => {
      const principal = createSystemPrincipal(request.tenantId);
      const closureRow = isUuid(request.tenantId) && isUuid(request.closureRequestId)
        ? (await client.query("select * from public.ordering_order_closure_requests where tenant_id = $1 and id = $2", [request.tenantId, request.closureRequestId])).rows[0]
        : undefined;
      const [order] = closureRow ? await loadOrders(client, request.tenantId, { orderId: closureRow.order_id, lock: "update" }) : [];
      let closureRequests: OrderClosureRequest[] = [];
      let closures: OrderClosure[] = [];
      let fulfillments: Fulfillment[] = [];
      let paymentLedger: Awaited<ReturnType<typeof loadLedger>> | undefined;
      let allocations: ReceiptAllocation[] = [];
      let cancellations: AllocationCancellation[] = [];
      let intakes: StockIntake[] = [];
      let returnRequests: ReturnRequest[] = [];
      let completions: ReturnCompletion[] = [];
      let exceptions: ReturnException[] = [];
      let resolutions: ReturnExceptionResolution[] = [];
      if (order) {
        await lockFul(client, order);
        closureRequests = (await client.query("select * from public.ordering_order_closure_requests where tenant_id = $1 and order_id = $2", [order.tenantId, order.id])).rows.map(toClosureRequest);
        closures = (await client.query("select * from public.ordering_order_closures where tenant_id = $1 and order_id = $2 order by recorded_at, id", [order.tenantId, order.id])).rows.map(toClosure);
        fulfillments = await loadFulfillments(client, order.tenantId, order.id);
        paymentLedger = await loadLedger(client, order);
        const allocRows = (await client.query("select * from public.ordering_receipt_allocations where tenant_id = $1 and order_id = $2", [order.tenantId, order.id])).rows;
        allocations = allocRows.map((a): ReceiptAllocation => ({ id: a.id, tenantId: a.tenant_id, receiptId: a.receipt_id, orderId: a.order_id, orderLineId: a.order_line_id, quantity: a.quantity, allocatedBy: a.allocated_by, allocatedAt: iso(a.allocated_at), recordedAt: iso(a.recorded_at) }));
        const allocIds = allocations.map((a) => a.id);
        cancellations = (await client.query("select * from public.ordering_allocation_cancellations where tenant_id = $1 and allocation_id = any($2::uuid[])", [order.tenantId, allocIds])).rows.map(
          (c): AllocationCancellation => ({ id: c.id, tenantId: c.tenant_id, bookId: c.book_key, receiptId: c.receipt_id, allocationId: c.allocation_id, orderId: c.order_id, orderLineId: c.order_line_id, quantity: c.quantity, reason: c.reason, cancelledBy: c.cancelled_by, cancelledAt: iso(c.cancelled_at), recordedAt: iso(c.recorded_at) }),
        );
        const cancelIds = cancellations.map((c) => c.id);
        intakes = (await client.query("select * from public.ordering_stock_intakes where tenant_id = $1 and cancellation_id = any($2::uuid[])", [order.tenantId, cancelIds])).rows.map(
          (i): StockIntake => ({ id: i.id, tenantId: i.tenant_id, bookId: "", cancellationId: i.cancellation_id, receiptId: "", orderId: order.id, orderLineId: "", quantity: i.quantity, actedBy: i.acted_by, actedAt: iso(i.acted_at), recordedAt: iso(i.recorded_at) }),
        );
        returnRequests = (await client.query("select * from public.ordering_return_requests where tenant_id = $1 and cancellation_id = any($2::uuid[])", [order.tenantId, cancelIds])).rows.map(
          (r): ReturnRequest => ({ id: r.id, tenantId: r.tenant_id, bookId: "", cancellationId: r.cancellation_id, receiptId: "", supplierCode: "", quantity: r.quantity, requestedBy: r.requested_by, requestedAt: iso(r.requested_at), recordedAt: iso(r.recorded_at) }),
        );
        const reqIds = returnRequests.map((r) => r.id);
        completions = (await client.query("select * from public.ordering_return_completions where tenant_id = $1 and return_request_id = any($2::uuid[])", [order.tenantId, reqIds])).rows.map(
          (c): ReturnCompletion => ({ id: c.id, tenantId: c.tenant_id, returnRequestId: c.return_request_id, quantity: c.quantity, evidence: "", confirmedBy: c.confirmed_by, confirmedAt: iso(c.confirmed_at), recordedAt: iso(c.recorded_at) }),
        );
        exceptions = (await client.query("select * from public.ordering_return_exceptions where tenant_id = $1 and return_request_id = any($2::uuid[])", [order.tenantId, reqIds])).rows.map(
          (e): ReturnException => ({ id: e.id, tenantId: e.tenant_id, returnRequestId: e.return_request_id, quantity: e.quantity, kind: e.kind, evidence: "", reportedBy: e.reported_by, reportedAt: iso(e.reported_at), recordedAt: iso(e.recorded_at) }),
        );
        resolutions = (await client.query("select * from public.ordering_return_exception_resolutions where tenant_id = $1 and return_exception_id = any($2::uuid[])", [order.tenantId, exceptions.map((e) => e.id)])).rows.map(
          (r): ReturnExceptionResolution => ({ id: r.id, tenantId: r.tenant_id, returnExceptionId: r.return_exception_id, returnRequestId: exceptions.find((e) => e.id === r.return_exception_id)?.returnRequestId ?? "", outcome: r.outcome, quantity: r.quantity, evidence: "", resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at), recordedAt: iso(r.recorded_at) }),
        );
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const savedOrders: Order[] = [];
      const newClosures: OrderClosure[] = [];
      const pl = paymentLedger;
      const { tenantId: _t, ...rest } = request;
      void _t;
      const closureDeps: Parameters<typeof authorizedActions.executeOrderClosure>[0] = {
        orders: { get: (t, id) => (order && order.tenantId === t && order.id === id ? order : undefined), list: () => (order ? [order] : []), save: (o) => void savedOrders.push(o) },
        closureRequests: { get: (_t2, id) => closureRequests.find((r) => r.id === id), list: () => closureRequests, save: forbidden },
        orderClosures: { list: () => closures, save: (c) => void newClosures.push(c) },
        fulfillments: { list: () => fulfillments },
        payments: { list: (_t2, oid) => (pl?.payments ?? []).filter((p) => p.orderId === oid) },
        paymentConfirmations: { list: (_t2, id) => (pl?.confirmations ?? []).filter((c) => c.paymentId === id) },
        paymentVoids: { list: (_t2, id) => (pl?.voids ?? []).filter((v) => v.paymentId === id) },
        refundConfirmations: { list: (_t2, id) => (pl?.refunds ?? []).filter((r) => r.refundTaskId === id), listByOrder: (_t2, oid) => (pl?.refunds ?? []).filter((r) => r.orderId === oid) },
        refundTasks: { list: (_t2, oid) => (pl?.tasks ?? []).filter((r) => r.orderId === oid) },
        paymentCorrections: { listByOrder: (_t2, oid) => (pl?.corrections ?? []).filter((c) => c.orderId === oid) },
        receiptAllocations: { listByOrder: (_t2, oid) => allocations.filter((a) => a.orderId === oid) },
        allocationCancellations: { list: (_t2, id) => cancellations.filter((c) => c.allocationId === id) },
        stockIntakes: { list: (_t2, id) => intakes.filter((i) => i.cancellationId === id) },
        returnRequests: { list: (_t2, id) => returnRequests.filter((r) => r.cancellationId === id) },
        returnCompletions: { list: (_t2, id) => completions.filter((c) => c.returnRequestId === id) },
        returnExceptions: { list: (_t2, id) => exceptions.filter((e) => e.returnRequestId === id) },
        returnExceptionResolutions: { list: (_t2, id) => resolutions.filter((r) => r.returnExceptionId === id) },
        idempotency,
      };
      const result = authorizedActions.executeOrderClosure(closureDeps, principal, rest);
      for (const o of savedOrders) await saveOrder(client, o, order);
      for (const c of newClosures) {
        await client.query(
          "insert into public.ordering_order_closures (id, tenant_id, order_id, closure_request_id, order_version_before, order_version_after, executed_by, outcome, closed_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [c.id, c.tenantId, c.orderId, c.closureRequestId, c.orderVersionBefore, c.orderVersionAfter, c.executedBy, c.outcome ?? null, c.closedAt, c.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  async function insertDecisions(client: PoolClient, decisions: OrderCancellationDecision[]) {
    for (const d of decisions) {
      await client.query(
        "insert into public.ordering_order_cancellation_decisions (id, tenant_id, request_id, kind, decided_by, decided_at, note, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [d.id, d.tenantId, d.requestId, d.kind, d.decidedBy, d.decidedAt, d.note ?? null, d.recordedAt],
      );
    }
  }

  return {
    decideOrderCancellation: (actor: Actor, request: DecideOrderCancellationBody) => withRetry(() => decideOnce(actor, request)),
    applyOrderCancellation: (actor: Actor, request: ApplyOrderCancellationBody) => withRetry(() => applyOnce(actor, request)),
    requestOrderClosure: (actor: Actor, request: RequestOrderClosureBody) => withRetry(() => requestClosureOnce(actor, request)),
    /** 서버 내부 업무다. HTTP로 노출하지 않으며, 호출자는 서버 코드(작업 실행기)다 */
    executeOrderClosure: (request: ExecuteOrderClosureBody) => withRetry(() => executeClosureOnce(request)),
  };
}
