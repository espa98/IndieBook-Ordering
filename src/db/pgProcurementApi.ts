import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { UserPrincipal } from "../auth/principal";
import { AppError } from "../errors/AppError";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import type { Order } from "../order/createDraftOrder";
import type { ApproveDuplicateRiskRequest, DuplicateRiskApproval } from "../procurement/approveDuplicateRisk";
import type { AllocateSourcingRequest, SourcingAllocation, Supplier } from "../procurement/allocateSourcing";
import type { CreatePurchaseOrderRequest, PurchaseOrder } from "../procurement/createPurchaseOrder";
import type { CancelUndeliveredPurchaseOrderRequest } from "../procurement/cancelUndeliveredPurchaseOrder";
import type { ConfirmPurchaseOrderCancellationRequest } from "../procurement/confirmPurchaseOrderCancellation";
import type { CancellationRequest, CancellationResponse, CreateCancellationRequestRequest } from "../procurement/createCancellationRequest";
import type { RespondToCancellationRequestRequest } from "../procurement/respondToCancellationRequest";
import type { MarkPurchaseOrderReadyRequest } from "../procurement/markPurchaseOrderReady";
import type { ReleaseSourcingRequest, SourcingRelease } from "../procurement/releaseSourcing";
import type { RecordPurchaseOrderDeliveryRequest } from "../procurement/recordPurchaseOrderDelivery";
import type { PoReply, RecordSupplierReplyRequest } from "../procurement/recordSupplierReply";
import { loadPoState, polLockKey } from "./pgReceivingApi";
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
const forbidden = () => {
  throw new Error("this command must not write this ledger");
};

export type CreatePurchaseOrderBody = CreatePurchaseOrderRequest;
export type MarkPurchaseOrderReadyBody = MarkPurchaseOrderReadyRequest;
export type RecordPurchaseOrderDeliveryBody = Omit<RecordPurchaseOrderDeliveryRequest, "deliveredBy">;
export type RecordSupplierReplyBody = RecordSupplierReplyRequest;
export type CancelUndeliveredPurchaseOrderBody = Omit<CancelUndeliveredPurchaseOrderRequest, "cancelledBy">;
export type CreateCancellationRequestBody = CreateCancellationRequestRequest;
export type RespondToCancellationRequestBody = RespondToCancellationRequestRequest;
export type ConfirmPurchaseOrderCancellationBody = ConfirmPurchaseOrderCancellationRequest;
export type AllocateSourcingBody = AllocateSourcingRequest;
export type ApproveDuplicateRiskBody = Omit<ApproveDuplicateRiskRequest, "actorRole" | "approvedBy">;
export type ReleaseSourcingBody = Omit<ReleaseSourcingRequest, "releasedBy">;

/** 상태 전이 명령이 새로 저장할 기록 */
type Saved = { po: PurchaseOrder[]; replies: PoReply[]; cancellationRequests: CancellationRequest[]; cancellationResponses: CancellationResponse[] };

/** 발주 생성·전달 준비·전달 기록·공급처 회신을 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 락 순서: 배정 락('src:', 정렬 순) → 주문 행(공유). 발주 상태 전이는 발주 행을 `FOR UPDATE`로 잡는다. */
export function createPgProcurementApi(deps: { pool: PoolLike }) {
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

  const createOnce = (actor: Actor, request: CreatePurchaseOrderBody): Promise<PurchaseOrder> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const ids = Array.isArray(request.allocationIds) ? request.allocationIds.filter(isUuid) : [];
      for (const id of [...new Set(ids)].sort()) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`src:${request.tenantId}:${id}`]);
      }
      const supplier = isUuid(request.tenantId) && typeof request.supplierCode === "string"
        ? (await client.query("select * from public.ordering_suppliers where tenant_id = $1 and code = $2", [request.tenantId, request.supplierCode])).rows[0]
        : undefined;
      const allocations: SourcingAllocation[] = isUuid(request.tenantId)
        ? (await client.query("select * from public.ordering_sourcing_allocations where tenant_id = $1 and id = any($2::uuid[])", [request.tenantId, ids])).rows.map(
            (a): SourcingAllocation => ({ id: a.id, tenantId: a.tenant_id, orderId: a.order_id, lineId: a.order_line_id, supplierCode: a.supplier_code, quantity: a.quantity, status: a.status }),
          )
        : [];
      const orders: Order[] = [];
      for (const orderId of [...new Set(allocations.map((a) => a.orderId))].sort()) orders.push(...(await loadOrders(client, request.tenantId, { orderId, lock: "share" })));
      const linked = isUuid(request.tenantId)
        ? (
            await client.query(
              `select k.allocation_id, k.order_id, k.order_line_id, k.quantity from public.ordering_po_links k
                 join public.ordering_po_lines l on l.tenant_id = k.tenant_id and l.id = k.po_line_id
                 join public.ordering_purchase_orders p on p.tenant_id = l.tenant_id and p.id = l.purchase_order_id
                where k.tenant_id = $1 and k.allocation_id = any($2::uuid[]) and p.status <> 'CANCELLED'`,
              [request.tenantId, ids],
            )
          ).rows
        : [];
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: PurchaseOrder[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.createPurchaseOrder(
        {
          orders: { get: (t, id) => orders.find((o) => o.tenantId === t && o.id === id), list: () => orders, save: forbidden },
          suppliers: {
            get: (_t2, code): Supplier | undefined =>
              supplier && supplier.code === code ? { tenantId: supplier.tenant_id, code: supplier.code, active: supplier.active, ...(supplier.name === null ? {} : { name: supplier.name }), ...(supplier.order_channel === null ? {} : { orderChannel: supplier.order_channel }), version: Number(supplier.version) } : undefined,
          },
          allocations: { get: (_t2, id) => allocations.find((a) => a.id === id), list: () => allocations, save: forbidden },
          purchaseOrders: {
            get: forbidden as never,
            // 중복 연결 검사는 이 배정들에 이미 걸린 취소되지 않은 연결만 본다
            list: () => (linked.length === 0 ? [] : [{ id: "linked", tenantId: request.tenantId, supplierCode: "", status: "DRAFT", version: 1, lines: [{ poLineId: "linked", bookId: "", quantity: 0, links: linked.map((k) => ({ allocationId: k.allocation_id, orderId: k.order_id, orderLineId: k.order_line_id, quantity: k.quantity })) }] }]),
            save: (po) => void saved.push(po),
          },
          idempotency,
        },
        principal,
        rest,
      );
      for (const po of saved) await insertPurchaseOrder(client, po);
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  /** 발주 행을 잠그고 상태 전이 명령을 실행한다. `lineId`가 있으면 발주 품목 락('pol:')도 잡는다 */
  const transition = <B extends { tenantId: string; purchaseOrderId: string; idempotencyKey: string }, R>(
    actor: Actor,
    body: B,
    /** 잠글 발주 품목: 하나, 여러 개, 또는 발주 행을 잠근 뒤 찾아내는 함수 */
    lineId: string | string[] | undefined | ((client: PoolClient) => Promise<unknown>),
    run: (state: Awaited<ReturnType<typeof loadPoState>> | undefined, principal: UserPrincipal, idempotency: IdempotencyStore, saved: Saved, rest: Omit<B, "tenantId">) => R,
  ): Promise<R> =>
    withRetry(() =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
        const exists = isUuid(body.tenantId) && isUuid(body.purchaseOrderId)
          ? (await client.query("select 1 from public.ordering_purchase_orders where tenant_id = $1 and id = $2 for update", [body.tenantId, body.purchaseOrderId])).rowCount === 1
          : false;
        if (exists) {
          const resolved = typeof lineId === "function" ? await (lineId as (c: PoolClient) => Promise<unknown>)(client) : lineId;
          for (const id of [...new Set(Array.isArray(resolved) ? resolved : [resolved])].filter(isUuid).sort()) {
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [polLockKey(body.tenantId, id)]);
          }
        }
        const state = exists ? await loadPoState(client, body.tenantId, body.purchaseOrderId) : undefined;
        const idempotency = await loadCommands(client, body.tenantId, body.idempotencyKey);
        const known = new Set(idempotency.keys());
        const saved: Saved = { po: [], replies: [], cancellationRequests: [], cancellationResponses: [] };
        const { tenantId: _t, ...rest } = body;
        void _t;
        const result = run(state, principal, idempotency, saved, rest);
        for (const po of saved.po) {
          const updated = await client.query(
            "update public.ordering_purchase_orders set status = $3, version = $4, delivery = $5, cancelled_at = coalesce($7, cancelled_at), cancelled_by = coalesce($8, cancelled_by), cancel_reason = coalesce($9, cancel_reason) where tenant_id = $1 and id = $2 and version = $6",
            [po.tenantId, po.id, po.status, po.version, po.delivery ?? null, state?.po?.version, po.cancelledAt ?? null, po.cancelledBy ?? null, po.cancelReason ?? null],
          );
          if (updated.rowCount !== 1) throw new AppError("VERSION_CONFLICT");
        }
        for (const r of saved.replies) {
          await client.query(
            "insert into public.ordering_po_replies (id, tenant_id, purchase_order_id, po_line_id, kind, quantity, source, eta, evidence, replied_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            [r.id, r.tenantId, r.purchaseOrderId, r.poLineId, r.kind, r.quantity, r.source ?? null, r.eta ?? null, r.evidence, r.repliedAt, r.recordedAt],
          );
        }
        for (const r of saved.cancellationRequests) {
          await client.query("insert into public.ordering_po_cancellation_requests (id, tenant_id, purchase_order_id, po_line_id, quantity, reason, requested_at) values ($1, $2, $3, $4, $5, $6, $7)", [r.id, r.tenantId, r.purchaseOrderId, r.poLineId, r.quantity, r.reason, r.requestedAt]);
        }
        for (const r of saved.cancellationResponses) {
          await client.query(
            "insert into public.ordering_po_cancellation_responses (id, tenant_id, purchase_order_id, po_line_id, request_id, accepted_quantity, rejected_quantity, evidence, replied_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            [r.id, r.tenantId, r.purchaseOrderId, r.poLineId, r.requestId, r.acceptedQuantity, r.rejectedQuantity, r.evidence, r.repliedAt, r.recordedAt],
          );
        }
        await saveNewCommands(client, idempotency, known);
        return result;
      }),
    );
  type PoState = Awaited<ReturnType<typeof loadPoState>>;
  const cancellationRepo = (state: PoState | undefined, saved: Saved) => ({
    getRequest: (_t: string, id: string) => state?.requests.find((r) => r.id === id),
    listRequests: () => [...(state?.requests ?? []), ...saved.cancellationRequests],
    saveRequest: (r: CancellationRequest) => void saved.cancellationRequests.push(r),
    listResponses: () => [...(state?.responses ?? []), ...saved.cancellationResponses],
    saveResponse: (r: CancellationResponse) => void saved.cancellationResponses.push(r),
  });
  const poRepo = (state: { po?: PurchaseOrder } | undefined, saved: { po: PurchaseOrder[] }) => ({
    get: (_t: string, id: string) => (state?.po && state.po.id === id ? state.po : undefined),
    list: () => (state?.po ? [state.po] : []),
    save: (po: PurchaseOrder) => void saved.po.push(po),
  });

  const toSupplier = (row: any): Supplier | undefined =>
    row ? { tenantId: row.tenant_id, code: row.code, active: row.active, ...(row.name === null ? {} : { name: row.name }), ...(row.order_channel === null ? {} : { orderChannel: row.order_channel }), version: Number(row.version) } : undefined;
  const toAllocation = (a: any): SourcingAllocation => ({ id: a.id, tenantId: a.tenant_id, orderId: a.order_id, lineId: a.order_line_id, supplierCode: a.supplier_code, quantity: a.quantity, status: a.status });

  /** 주문이 풀어낸 배정 중 공급처 의무가 남은 것을 계산하는 데 필요한 기록을 적재한다 (BR-P05) */
  async function loadObligationDeps(client: PoolClient, tenantId: string, orderId: string) {
    const releases = (await client.query("select * from public.ordering_sourcing_releases where tenant_id = $1 and order_id = $2 order by recorded_at, id", [tenantId, orderId])).rows.map(
      (r): SourcingRelease => ({ id: r.id, tenantId: r.tenant_id, allocationId: r.allocation_id, orderId: r.order_id, lineId: r.order_line_id, supplierCode: r.supplier_code, quantity: r.quantity, reason: r.reason, retainedObligations: r.retained_obligations, releasedBy: r.released_by, releasedAt: r.released_at.toISOString(), recordedAt: r.recorded_at.toISOString() }),
    );
    const poIds = [...new Set(releases.flatMap((r) => r.retainedObligations.map((o) => o.purchaseOrderId)))].sort();
    const states: Awaited<ReturnType<typeof loadPoState>>[] = [];
    for (const poId of poIds) states.push(await loadPoState(client, tenantId, poId));
    const approvals = (await client.query("select * from public.ordering_duplicate_risk_approvals where tenant_id = $1 and order_id = $2 order by recorded_at, id", [tenantId, orderId])).rows.map(
      (a): DuplicateRiskApproval => ({ id: a.id, tenantId: a.tenant_id, orderId: a.order_id, lineId: a.order_line_id, purchaseOrderId: a.purchase_order_id, poLineId: a.po_line_id, surplusPlan: a.surplus_plan, planNote: a.plan_note, approvedBy: a.approved_by, approvedAt: a.approved_at.toISOString(), recordedAt: a.recorded_at.toISOString() }),
    );
    const supplierObligations = {
      purchaseOrders: { get: (_t: string, id: string) => states.find((st) => st.po?.id === id)?.po },
      replies: { list: (_t: string, poId: string) => states.find((st) => st.po?.id === poId)?.replies ?? [] },
      cancellations: { listResponses: (_t: string, poId: string) => states.find((st) => st.po?.id === poId)?.responses ?? [] },
      receipts: { list: (_t: string, poId: string) => states.find((st) => st.po?.id === poId)?.receipts ?? [] },
      receiptCorrections: { list: (_t: string, receiptId: string) => states.flatMap((st) => st.corrections).filter((c) => c.receiptId === receiptId) },
      sourcingReleases: { listByOrder: () => releases },
    };
    return { supplierObligations, approvals };
  }

  const allocateOnce = (actor: Actor, request: AllocateSourcingBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const [order] = isUuid(request.orderId) ? await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: "share" }) : [];
      if (order && isUuid(request.lineId)) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`sline:${request.tenantId}:${request.lineId}`]);
      const supplier = isUuid(request.tenantId) && typeof request.supplierCode === "string"
        ? toSupplier((await client.query("select * from public.ordering_suppliers where tenant_id = $1 and code = $2", [request.tenantId, request.supplierCode])).rows[0])
        : undefined;
      const existing = order ? (await client.query("select * from public.ordering_sourcing_allocations where tenant_id = $1 and order_id = $2", [order.tenantId, order.id])).rows.map(toAllocation) : [];
      const risk = order ? await loadObligationDeps(client, order.tenantId, order.id) : undefined;
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: SourcingAllocation[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.allocateSourcing(
        {
          orders: { get: (t, id) => (order && order.tenantId === t && order.id === id ? order : undefined), list: () => (order ? [order] : []), save: forbidden },
          suppliers: { get: (_t2, code) => (supplier && supplier.code === code ? supplier : undefined) },
          allocations: { get: (_t2, id) => existing.find((a) => a.id === id), list: () => existing, save: (a) => void saved.push(a) },
          ...(risk ? { supplierObligations: { ...risk.supplierObligations, duplicateRiskApprovals: { list: () => risk.approvals } } } : {}),
          idempotency,
        },
        principal,
        rest,
      );
      for (const a of saved) {
        await client.query("insert into public.ordering_sourcing_allocations (id, tenant_id, order_id, order_line_id, supplier_code, quantity, status) values ($1, $2, $3, $4, $5, $6, $7)", [a.id, a.tenantId, a.orderId, a.lineId, a.supplierCode, a.quantity, a.status]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const releaseOnce = (actor: Actor, request: ReleaseSourcingBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      let allocation: SourcingAllocation | undefined;
      let linked: PurchaseOrder[] = [];
      if (isUuid(request.tenantId) && isUuid(request.allocationId)) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`src:${request.tenantId}:${request.allocationId}`]);
        const row = (await client.query("select * from public.ordering_sourcing_allocations where tenant_id = $1 and id = $2 for update", [request.tenantId, request.allocationId])).rows[0];
        allocation = row ? toAllocation(row) : undefined;
        if (allocation) {
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`sline:${request.tenantId}:${allocation.lineId}`]);
          const links = (
            await client.query(
              `select p.id as po_id, p.status, p.version, p.supplier_code, k.po_line_id, l.book_key, k.order_id, k.order_line_id, k.quantity
                 from public.ordering_po_links k
                 join public.ordering_po_lines l on l.tenant_id = k.tenant_id and l.id = k.po_line_id
                 join public.ordering_purchase_orders p on p.tenant_id = l.tenant_id and p.id = l.purchase_order_id
                where k.tenant_id = $1 and k.allocation_id = $2 and p.status <> 'CANCELLED'`,
              [request.tenantId, request.allocationId],
            )
          ).rows;
          linked = links.map((k) => ({
            id: k.po_id,
            tenantId: request.tenantId,
            supplierCode: k.supplier_code,
            status: k.status,
            version: Number(k.version),
            lines: [{ poLineId: k.po_line_id, bookId: k.book_key, quantity: k.quantity, links: [{ allocationId: request.allocationId, orderId: k.order_id, orderLineId: k.order_line_id, quantity: k.quantity }] }],
          }));
        }
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const savedAllocations: SourcingAllocation[] = [];
      const savedReleases: SourcingRelease[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.releaseSourcing(
        {
          allocations: { get: (_t2, id) => (allocation && allocation.id === id ? allocation : undefined), list: () => (allocation ? [allocation] : []), save: (a) => void savedAllocations.push(a) },
          purchaseOrders: { get: forbidden as never, list: () => linked, save: forbidden },
          sourcingReleases: { list: () => [], save: (r) => void savedReleases.push(r) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const a of savedAllocations) await client.query("update public.ordering_sourcing_allocations set status = $3 where tenant_id = $1 and id = $2", [a.tenantId, a.id, a.status]);
      for (const r of savedReleases) {
        await client.query(
          "insert into public.ordering_sourcing_releases (id, tenant_id, allocation_id, order_id, order_line_id, supplier_code, quantity, reason, retained_obligations, released_by, released_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
          [r.id, r.tenantId, r.allocationId, r.orderId, r.lineId, r.supplierCode, r.quantity, r.reason, JSON.stringify(r.retainedObligations), r.releasedBy, r.releasedAt, r.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const approveRiskOnce = (actor: Actor, request: ApproveDuplicateRiskBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const [order] = isUuid(request.orderId) ? await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: "share" }) : [];
      if (order && isUuid(request.lineId)) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`sline:${request.tenantId}:${request.lineId}`]);
      const risk = order ? await loadObligationDeps(client, order.tenantId, order.id) : undefined;
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: DuplicateRiskApproval[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const none = { purchaseOrders: { get: () => undefined }, replies: { list: () => [] }, cancellations: { listResponses: () => [] }, receipts: { list: () => [] }, receiptCorrections: { list: () => [] }, sourcingReleases: { listByOrder: () => [] } };
      const result = authorizedActions.approveDuplicateRisk(
        {
          supplierObligations: risk?.supplierObligations ?? none,
          duplicateRiskApprovals: { list: () => risk?.approvals ?? [], save: (a) => void saved.push(a) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const a of saved) {
        await client.query(
          "insert into public.ordering_duplicate_risk_approvals (id, tenant_id, order_id, order_line_id, purchase_order_id, po_line_id, surplus_plan, plan_note, approved_by, approved_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [a.id, a.tenantId, a.orderId, a.lineId, a.purchaseOrderId, a.poLineId, a.surplusPlan, a.planNote, a.approvedBy, a.approvedAt, a.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  async function insertPurchaseOrder(client: PoolClient, po: PurchaseOrder) {
    await client.query("insert into public.ordering_purchase_orders (id, tenant_id, supplier_code, status, version) values ($1, $2, $3, $4, $5)", [po.id, po.tenantId, po.supplierCode, po.status, po.version]);
    for (const line of po.lines) {
      await client.query("insert into public.ordering_po_lines (id, tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, $4, $5)", [line.poLineId, po.tenantId, po.id, line.bookId, line.quantity]);
      for (const link of line.links) {
        await client.query("insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, $3, $4, $5, $6)", [po.tenantId, line.poLineId, link.allocationId, link.orderId, link.orderLineId, link.quantity]);
      }
    }
  }

  void (undefined as unknown as IdempotencyStore);
  void (undefined as unknown as UserPrincipal);
  return {
    allocateSourcing: (actor: Actor, request: AllocateSourcingBody) => withRetry(() => allocateOnce(actor, request)),
    approveDuplicateRisk: (actor: Actor, request: ApproveDuplicateRiskBody) => withRetry(() => approveRiskOnce(actor, request)),
    releaseSourcing: (actor: Actor, request: ReleaseSourcingBody) => withRetry(() => releaseOnce(actor, request)),
    createPurchaseOrder: (actor: Actor, request: CreatePurchaseOrderBody) => withRetry(() => createOnce(actor, request)),
    markPurchaseOrderReady: (actor: Actor, body: MarkPurchaseOrderReadyBody) =>
      transition(actor, body, undefined, (state, principal, idempotency, saved, rest) =>
        authorizedActions.markPurchaseOrderReady({ purchaseOrders: poRepo(state, saved), idempotency }, principal, rest),
      ),
    recordPurchaseOrderDelivery: (actor: Actor, body: RecordPurchaseOrderDeliveryBody) =>
      transition(actor, body, undefined, (state, principal, idempotency, saved, rest) =>
        authorizedActions.recordPurchaseOrderDelivery({ purchaseOrders: poRepo(state, saved), exports: { list: () => [], save: forbidden }, idempotency }, principal, rest),
      ),
    cancelUndeliveredPurchaseOrder: (actor: Actor, body: CancelUndeliveredPurchaseOrderBody) =>
      transition(actor, body, undefined, (state, principal, idempotency, saved, rest) =>
        authorizedActions.cancelUndeliveredPurchaseOrder({ purchaseOrders: poRepo(state, saved), idempotency }, principal, rest),
      ),
    createCancellationRequest: (actor: Actor, body: CreateCancellationRequestBody) =>
      transition(actor, body, body.poLineId, (state, principal, idempotency, saved, rest) =>
        authorizedActions.createCancellationRequest(
          { purchaseOrders: poRepo(state, saved), replies: { list: () => state?.replies ?? [], save: forbidden }, cancellations: cancellationRepo(state, saved), idempotency },
          principal,
          rest,
        ),
      ),
    respondToCancellationRequest: (actor: Actor, body: RespondToCancellationRequestBody) =>
      transition(
        actor,
        body,
        async (client) => (isUuid(body.cancellationRequestId) ? (await client.query("select po_line_id from public.ordering_po_cancellation_requests where tenant_id = $1 and id = $2", [body.tenantId, body.cancellationRequestId])).rows[0]?.po_line_id : undefined),
        (state, principal, idempotency, saved, rest) =>
          authorizedActions.respondToCancellationRequest(
            { purchaseOrders: poRepo(state, saved), replies: { list: () => state?.replies ?? [], save: forbidden }, cancellations: cancellationRepo(state, saved), idempotency },
            principal,
            rest,
          ),
      ),
    confirmPurchaseOrderCancellation: (actor: Actor, body: ConfirmPurchaseOrderCancellationBody) =>
      transition(
        actor,
        body,
        async (client) => (await client.query("select id from public.ordering_po_lines where tenant_id = $1 and purchase_order_id = $2", [body.tenantId, body.purchaseOrderId])).rows.map((r) => r.id as string),
        (state, principal, idempotency, saved, rest) =>
          authorizedActions.confirmPurchaseOrderCancellation(
            { purchaseOrders: poRepo(state, saved), replies: { list: () => state?.replies ?? [], save: forbidden }, cancellations: cancellationRepo(state, saved), idempotency },
            principal,
            rest,
          ),
      ),
    recordSupplierReply: (actor: Actor, body: RecordSupplierReplyBody) =>
      transition(actor, body, body.poLineId, (state, principal, idempotency, saved, rest) =>
        authorizedActions.recordSupplierReply(
          {
            purchaseOrders: poRepo(state, saved),
            replies: { list: () => state?.replies ?? [], save: (r) => void saved.replies.push(r) },
            cancellations: {
              getRequest: (_t, id) => state?.requests.find((r) => r.id === id),
              listRequests: () => state?.requests ?? [],
              saveRequest: forbidden,
              listResponses: () => state?.responses ?? [],
              saveResponse: forbidden,
            },
            idempotency,
          },
          principal,
          rest,
        ),
      ),
  };
}
