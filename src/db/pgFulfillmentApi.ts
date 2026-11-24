import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import { AppError } from "../errors/AppError";
import type { Fulfillment, PostFulfillmentRequest } from "../fulfillment/postFulfillment";
import type { StockReservationDelivery } from "../inventory/deliverStockReservation";
import type { StockMovement } from "../inventory/registerInitialStock";
import type { StockReservationRelease } from "../inventory/releaseStockReservation";
import type { StockReservationRecord } from "../inventory/reserveStock";
import type {
  OrderCancellationDecision,
  OrderCancellationRequest,
  RequestOrderCancellationRequest,
} from "../order/requestOrderCancellation";
import type { ReceiptAllocation } from "../inventory/allocateReceipt";
import type { AllocationCancellation } from "../inventory/cancelAllocation";
import type { AllocationDelivery } from "../inventory/deliverAllocation";
import type { AllocationRelease } from "../inventory/releaseAllocation";
import { loadLedger } from "./pgPaymentApi";
import { loadAllocationLedger, polLockKey } from "./pgReceivingApi";
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

export type PostFulfillmentBody = Omit<PostFulfillmentRequest, "receivedBy">;
export type RequestOrderCancellationBody = Omit<RequestOrderCancellationRequest, "requestedBy">;

export async function loadFulfillments(client: PoolClient, tenantId: string, orderId: string): Promise<Fulfillment[]> {
  return (
    await client.query("select * from public.ordering_fulfillments where tenant_id = $1 and order_id = $2 order by recorded_at, id", [tenantId, orderId])
  ).rows.map(
    (f): Fulfillment => ({
      id: f.id,
      tenantId: f.tenant_id,
      orderId: f.order_id,
      orderLineId: f.order_line_id,
      quantity: f.quantity,
      unitPriceKrw: String(f.unit_price_krw),
      amountKrw: String(f.amount_krw),
      sources: f.sources,
      receivedBy: f.received_by,
      receivedAt: iso(f.received_at),
      recordedAt: iso(f.recorded_at),
      ...(f.corrects_fulfillment_id === null ? {} : { correctsFulfillmentId: f.corrects_fulfillment_id }),
    }),
  );
}

export async function loadCancellations(client: PoolClient, tenantId: string, orderId: string) {
  const requests = (
    await client.query("select * from public.ordering_order_cancellation_requests where tenant_id = $1 and order_id = $2 order by recorded_at, id", [tenantId, orderId])
  ).rows.map(
    (r): OrderCancellationRequest => ({
      id: r.id,
      tenantId: r.tenant_id,
      orderId: r.order_id,
      orderLineId: r.order_line_id,
      quantity: r.quantity,
      reason: r.reason,
      baseVersion: Number(r.base_version),
      requestedBy: r.requested_by,
      requestedAt: iso(r.requested_at),
      recordedAt: iso(r.recorded_at),
    }),
  );
  const decisions = (
    await client.query("select * from public.ordering_order_cancellation_decisions where tenant_id = $1 and request_id = any($2::uuid[]) order by seq", [tenantId, requests.map((r) => r.id)])
  ).rows.map(
    (d): OrderCancellationDecision => ({
      id: d.id,
      tenantId: d.tenant_id,
      requestId: d.request_id,
      kind: d.kind,
      decidedBy: d.decided_by,
      decidedAt: iso(d.decided_at),
      ...(d.note === null ? {} : { note: d.note }),
      recordedAt: iso(d.recorded_at),
    }),
  );
  return { requests, decisions };
}

/**
 * 수령(인도)과 주문 취소 요청을 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 락 순서는 주문 행 → 주문 인도 락(`ful:`) → 책 락(정렬 순)으로 고정되어 같은 책을 다루는 인도끼리, 인도와 취소 요청 사이에서
 * 교착 없이 직렬화된다. 같은 락을 DB 트리거도 잡아 어댑터를 거치지 않는 쓰기도 막는다.
 * 재고 예약 출처와 입고 배분 출처를 모두 영속화한다. 락 순서는 주문 → 인도 → 책 → 발주 품목이다.
 */
export function createPgFulfillmentApi(deps: { pool: PoolLike }) {
  async function postOnce(actor: Actor, request: PostFulfillmentBody): Promise<Fulfillment> {
    return inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const sources = Array.isArray(request.sources) ? request.sources : [];

      const [order] = await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: "share" });
      let reservations: StockReservationRecord[] = [];
      let releases: StockReservationRelease[] = [];
      let deliveries: StockReservationDelivery[] = [];
      let movements: StockMovement[] = [];
      let fulfillments: Fulfillment[] = [];
      let requests: OrderCancellationRequest[] = [];
      let decisions: OrderCancellationDecision[] = [];
      let paymentLedger: Awaited<ReturnType<typeof loadLedger>> | undefined;
      let allocations: ReceiptAllocation[] = [];
      let allocationReleases: AllocationRelease[] = [];
      let allocationDeliveries: AllocationDelivery[] = [];
      let allocationCancellations: AllocationCancellation[] = [];
      if (order) {
        // 같은 주문의 인도·취소 요청을 직렬화한 뒤, 출처 예약의 책 락을 정렬 순으로 잡는다
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ful:${order.tenantId}:${order.id}`]);
        const sourceIds = sources.map((s) => s?.sourceId).filter(isUuid);
        const sourceRows =
          sourceIds.length === 0
            ? []
            : (await client.query("select distinct book_key from public.ordering_stock_reservations where tenant_id = $1 and id = any($2::uuid[])", [order.tenantId, sourceIds])).rows;
        const bookKeys = sourceRows.map((r) => r.book_key as string).sort();
        for (const book of bookKeys) {
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${order.tenantId}:${book}`]);
        }
        for (const book of bookKeys) {
          const ledger = await loadBookLedger(client, order.tenantId, book);
          reservations = reservations.concat(ledger.reservations);
          releases = releases.concat(ledger.releases);
          deliveries = deliveries.concat(ledger.deliveries);
          movements = movements.concat(ledger.movements);
        }
        // 입고 배분 출처의 발주 품목 락은 책 락 뒤에 정렬 순으로 잡는다(락 순서: 주문 → 인도 → 책 → 발주 품목)
        const allocationIds = sources.filter((s) => s?.kind === "RECEIPT_ALLOCATION").map((s) => s.sourceId).filter(isUuid);
        if (allocationIds.length > 0) {
          const lines = (
            await client.query(
              `select distinct g.po_line_id from public.ordering_receipt_allocations a
                 join public.ordering_goods_receipts g on g.tenant_id = a.tenant_id and g.id = a.receipt_id
                where a.tenant_id = $1 and a.id = any($2::uuid[])`,
              [order.tenantId, allocationIds],
            )
          ).rows.map((r) => r.po_line_id as string);
          for (const line of lines.sort()) {
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [polLockKey(order.tenantId, line)]);
          }
          ({ allocations, releases: allocationReleases, deliveries: allocationDeliveries, cancellations: allocationCancellations } = await loadAllocationLedger(client, order.tenantId, allocationIds));
        }
        fulfillments = await loadFulfillments(client, order.tenantId, order.id);
        ({ requests, decisions } = await loadCancellations(client, order.tenantId, order.id));
        paymentLedger = await loadLedger(client, order);
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const knownCommands = new Set(idempotency.keys());

      const newDeliveries: StockReservationDelivery[] = [];
      const newMovements: StockMovement[] = [];
      const newAllocationDeliveries: AllocationDelivery[] = [];
      const newFulfillments: Fulfillment[] = [];
      const forbidden = () => {
        throw new Error("this command must not write this ledger");
      };
      const { tenantId: _tenantId, ...rest } = request;
      void _tenantId;
      const postDeps: Parameters<typeof authorizedActions.postFulfillment>[0] =
        {
          orders: {
            get: (t, id) => (order && order.tenantId === t && order.id === id ? order : undefined),
            list: () => (order ? [order] : []),
            save: forbidden,
          },
          fulfillments: { list: () => fulfillments, save: (f) => void newFulfillments.push(f) },
          orderCancellationRequests: { list: () => requests },
          orderCancellationDecisions: { list: (_t, requestId) => decisions.filter((d) => d.requestId === requestId) },
          payments: {
            get: (_t, id) => paymentLedger?.payments.find((p) => p.id === id),
            list: (_t, orderId) => (paymentLedger?.payments ?? []).filter((p) => p.orderId === orderId),
            listByTenant: () => paymentLedger?.payments ?? [],
            save: forbidden,
          },
          paymentConfirmations: { list: (_t, paymentId) => (paymentLedger?.confirmations ?? []).filter((c) => c.paymentId === paymentId) },
          paymentVoids: { list: (_t, paymentId) => (paymentLedger?.voids ?? []).filter((v) => v.paymentId === paymentId) },
          stockReservations: { get: (_t, id) => reservations.find((r) => r.id === id), list: (_t, bookId) => reservations.filter((r) => r.bookId === bookId), save: forbidden },
          stockReservationReleases: { list: (_t, reservationId) => releases.filter((r) => r.reservationId === reservationId), save: forbidden },
          stockReservationDeliveries: {
            list: (_t, reservationId) => deliveries.filter((d) => d.reservationId === reservationId),
            save: (d) => void newDeliveries.push(d),
          },
          stockMovements: { list: (_t, bookId) => movements.filter((m) => m.bookId === bookId), save: (m) => void newMovements.push(m) },
          receiptAllocations: {
            get: (_t, id) => allocations.find((a) => a.id === id),
            listByOrder: (_t, orderId) => allocations.filter((a) => a.orderId === orderId),
            list: (_t, receiptId) => allocations.filter((a) => a.receiptId === receiptId),
            save: forbidden,
          },
          allocationReleases: { list: (_t, allocationId) => allocationReleases.filter((r) => r.allocationId === allocationId), save: forbidden },
          allocationDeliveries: {
            list: (_t, allocationId) => allocationDeliveries.filter((d) => d.allocationId === allocationId),
            save: (d) => void newAllocationDeliveries.push(d),
          },
          allocationCancellations: { list: (_t, allocationId) => allocationCancellations.filter((c) => c.allocationId === allocationId) },
          idempotency,
        };
      const result = authorizedActions.postFulfillment(postDeps, principal, rest);

      // 참조되는 쪽부터 저장한다: 예약 인도 → 재고 이동 → 수령 기록
      for (const d of newDeliveries) {
        await client.query(
          "insert into public.ordering_stock_reservation_deliveries (id, tenant_id, reservation_id, quantity, delivered_by, delivered_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)",
          [d.id, d.tenantId, d.reservationId, d.quantity, d.deliveredBy, d.deliveredAt, d.recordedAt],
        );
      }
      for (const m of newMovements) {
        await client.query(
          "insert into public.ordering_stock_movements (id, tenant_id, book_key, kind, direction, quantity, reason, reservation_id, cancellation_id, acted_by, acted_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
          [m.id, m.tenantId, m.bookId, m.kind, m.direction, m.quantity, m.reason, m.reservationId ?? null, m.cancellationId ?? null, m.actedBy, m.actedAt, m.recordedAt],
        );
      }
      for (const d of newAllocationDeliveries) {
        await client.query(
          "insert into public.ordering_allocation_deliveries (id, tenant_id, allocation_id, receipt_id, order_id, order_line_id, quantity, delivered_by, delivered_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [d.id, d.tenantId, d.allocationId, d.receiptId, d.orderId, d.orderLineId, d.quantity, d.deliveredBy, d.deliveredAt, d.recordedAt],
        );
      }
      for (const f of newFulfillments) {
        await client.query(
          "insert into public.ordering_fulfillments (id, tenant_id, order_id, order_line_id, quantity, unit_price_krw, amount_krw, sources, received_by, received_at, recorded_at, corrects_fulfillment_id) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)",
          [f.id, f.tenantId, f.orderId, f.orderLineId, f.quantity, f.unitPriceKrw, f.amountKrw, JSON.stringify(f.sources), f.receivedBy, f.receivedAt, f.recordedAt, f.correctsFulfillmentId ?? null],
        );
      }
      await saveNewCommands(client, idempotency, knownCommands);
      return result;
    });
  }

  async function cancelOnce(actor: Actor, request: RequestOrderCancellationBody): Promise<OrderCancellationRequest> {
    return inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const [order] = await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: "share" });
      let fulfillments: Fulfillment[] = [];
      let requests: OrderCancellationRequest[] = [];
      let decisions: OrderCancellationDecision[] = [];
      if (order) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ful:${order.tenantId}:${order.id}`]);
        fulfillments = await loadFulfillments(client, order.tenantId, order.id);
        ({ requests, decisions } = await loadCancellations(client, order.tenantId, order.id));
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const knownCommands = new Set(idempotency.keys());
      const saved: OrderCancellationRequest[] = [];
      const forbidden = () => {
        throw new Error("this command must not write this ledger");
      };
      const { tenantId: _tenantId, ...rest } = request;
      void _tenantId;
      const result = authorizedActions.requestOrderCancellation(
        {
          orders: {
            get: (t, id) => (order && order.tenantId === t && order.id === id ? order : undefined),
            list: () => (order ? [order] : []),
            save: forbidden,
          },
          orderCancellationRequests: { get: (_t, id) => requests.find((r) => r.id === id), list: () => requests, save: (r) => void saved.push(r) },
          orderCancellationDecisions: { list: (_t, requestId) => decisions.filter((d) => d.requestId === requestId) },
          fulfillments: { list: () => fulfillments },
          idempotency,
        },
        principal,
        rest,
      );
      for (const r of saved) {
        await client.query(
          "insert into public.ordering_order_cancellation_requests (id, tenant_id, order_id, order_line_id, quantity, reason, base_version, requested_by, requested_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [r.id, r.tenantId, r.orderId, r.orderLineId, r.quantity, r.reason, r.baseVersion, r.requestedBy, r.requestedAt, r.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, knownCommands);
      return result;
    });
  }

  async function withRetry<T>(run: () => Promise<T>): Promise<T> {
    // 같은 멱등 키가 동시에 들어오면 한쪽의 저장이 유일 제약에 걸린다. 한 번 다시 시도하면 먼저 저장된 결과를 본다
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        // DB 가드가 거부했다면 도메인 검사와 DB 상태가 어긋난 것(주로 동시 경쟁)이다. 업무 규칙 위반으로 돌려준다
        if ((error as { code?: string }).code === "P0001") {
          throw new AppError("BUSINESS_INVARIANT", (error as Error).message);
        }
        throw error;
      }
    }
  }

  return {
    postFulfillment: (actor: Actor, request: PostFulfillmentBody) => withRetry(() => postOnce(actor, request)),
    requestOrderCancellation: (actor: Actor, request: RequestOrderCancellationBody) => withRetry(() => cancelOnce(actor, request)),
  };
}
