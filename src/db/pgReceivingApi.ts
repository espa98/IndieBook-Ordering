import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { CorrectReceiptRequest, ReceiptCorrection } from "../inventory/correctReceipt";
import type { DecideExcessReceiptRequest, ExcessDecision } from "../inventory/decideExcessReceipt";
import type { ReceiptDefectResolution, ResolveReceiptDefectRequest } from "../inventory/resolveReceiptDefect";
import { AppError } from "../errors/AppError";
import type { ReceiptAllocation, AllocateReceiptRequest } from "../inventory/allocateReceipt";
import type { AllocationCancellation, CancelAllocationRequest } from "../inventory/cancelAllocation";
import type { AllocationDelivery } from "../inventory/deliverAllocation";
import type { GoodsReceipt, ReceiveGoodsRequest } from "../inventory/receiveGoods";
import type { ReallocateAllocationRequest } from "../inventory/reallocateAllocation";
import type { AllocationRelease, ReleaseAllocationRequest } from "../inventory/releaseAllocation";
import type { CancellationRequest, CancellationResponse } from "../procurement/createCancellationRequest";
import type { PurchaseOrder } from "../procurement/createPurchaseOrder";
import type { PoReply } from "../procurement/recordSupplierReply";
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
/** 트리거가 잡는 락 키와 같은 문자열(소문자 UUID)이어야 한다 */
export const polLockKey = (tenantId: string, poLineId: string) => `pol:${tenantId.toLowerCase()}:${poLineId.toLowerCase()}`;

export type ReceiveGoodsBody = Omit<ReceiveGoodsRequest, "inspectedBy">;
export type AllocateReceiptBody = Omit<AllocateReceiptRequest, "allocatedBy">;
export type CancelAllocationBody = Omit<CancelAllocationRequest, "actorRole" | "cancelledBy">;
export type ReallocateAllocationBody = Omit<ReallocateAllocationRequest, "actorRole" | "actedBy">;
export type ResolveReceiptDefectBody = Omit<ResolveReceiptDefectRequest, "actorRole" | "resolvedBy">;
export type DecideExcessReceiptBody = Omit<DecideExcessReceiptRequest, "actorRole" | "decidedBy">;
export type CorrectReceiptBody = Omit<CorrectReceiptRequest, "actorRole" | "correctedBy">;
export type ReleaseAllocationBody = Omit<ReleaseAllocationRequest, "releasedBy">;

async function loadPurchaseOrder(client: PoolClient, tenantId: string, poId: string): Promise<PurchaseOrder | undefined> {
  const [po] = (await client.query("select * from public.ordering_purchase_orders where tenant_id = $1 and id = $2", [tenantId, poId])).rows;
  if (!po) return undefined;
  const lines = (await client.query("select * from public.ordering_po_lines where tenant_id = $1 and purchase_order_id = $2 order by id", [tenantId, poId])).rows;
  const links = (
    await client.query("select * from public.ordering_po_links where tenant_id = $1 and po_line_id = any($2::uuid[]) order by id", [tenantId, lines.map((l) => l.id)])
  ).rows;
  return {
    id: po.id,
    tenantId: po.tenant_id,
    supplierCode: po.supplier_code,
    status: po.status,
    version: Number(po.version),
    lines: lines.map((l) => ({
      poLineId: l.id,
      bookId: l.book_key,
      quantity: l.quantity,
      links: links
        .filter((k) => k.po_line_id === l.id)
        .map((k) => ({ allocationId: k.allocation_id, orderId: k.order_id, orderLineId: k.order_line_id, quantity: k.quantity })),
    })),
    ...(po.delivery === null ? {} : { delivery: po.delivery }),
    ...(po.cancelled_at === null ? {} : { cancelledAt: iso(po.cancelled_at) }),
  };
}

const toReceipt = (r: any): GoodsReceipt => ({
  id: r.id,
  tenantId: r.tenant_id,
  purchaseOrderId: r.purchase_order_id,
  poLineId: r.po_line_id,
  normalQuantity: r.normal_quantity,
  excessQuantity: r.excess_quantity,
  damagedQuantity: r.damaged_quantity,
  misdeliveredQuantity: r.misdelivered_quantity,
  inspectedBy: r.inspected_by,
  receivedAt: iso(r.received_at),
  recordedAt: iso(r.recorded_at),
});
const toAllocation = (a: any): ReceiptAllocation => ({
  id: a.id,
  tenantId: a.tenant_id,
  receiptId: a.receipt_id,
  orderId: a.order_id,
  orderLineId: a.order_line_id,
  quantity: a.quantity,
  allocatedBy: a.allocated_by,
  allocatedAt: iso(a.allocated_at),
  recordedAt: iso(a.recorded_at),
});

/** 배분의 해제·인도·취소 처분 기록을 적재한다(잔량 계산용). 수령 어댑터도 재사용한다 */
export async function loadAllocationLedger(client: PoolClient, tenantId: string, allocationIds: string[]) {
  const ids = allocationIds.filter(isUuid);
  const allocations = (await client.query("select * from public.ordering_receipt_allocations where tenant_id = $1 and id = any($2::uuid[])", [tenantId, ids])).rows.map(toAllocation);
  const releases = (await client.query("select * from public.ordering_allocation_releases where tenant_id = $1 and allocation_id = any($2::uuid[]) order by recorded_at, id", [tenantId, ids])).rows.map(
    (r): AllocationRelease => ({ id: r.id, tenantId: r.tenant_id, allocationId: r.allocation_id, quantity: r.quantity, reason: r.reason, releasedBy: r.released_by, releasedAt: iso(r.released_at), recordedAt: iso(r.recorded_at) }),
  );
  const deliveries = (await client.query("select * from public.ordering_allocation_deliveries where tenant_id = $1 and allocation_id = any($2::uuid[]) order by recorded_at, id", [tenantId, ids])).rows.map(
    (d): AllocationDelivery => ({ id: d.id, tenantId: d.tenant_id, allocationId: d.allocation_id, receiptId: d.receipt_id, orderId: d.order_id, orderLineId: d.order_line_id, quantity: d.quantity, deliveredBy: d.delivered_by, deliveredAt: iso(d.delivered_at), recordedAt: iso(d.recorded_at) }),
  );
  const cancellations = (await client.query("select * from public.ordering_allocation_cancellations where tenant_id = $1 and allocation_id = any($2::uuid[]) order by recorded_at, id", [tenantId, ids])).rows.map(
    (c): AllocationCancellation => ({ id: c.id, tenantId: c.tenant_id, bookId: c.book_key, receiptId: c.receipt_id, allocationId: c.allocation_id, orderId: c.order_id, orderLineId: c.order_line_id, quantity: c.quantity, reason: c.reason, cancelledBy: c.cancelled_by, cancelledAt: iso(c.cancelled_at), recordedAt: iso(c.recorded_at) }),
  );
  return { allocations, releases, deliveries, cancellations };
}

/** 발주 하나의 입고·배분 상태 전체를 적재한다 */
export async function loadPoState(client: PoolClient, tenantId: string, poId: string) {
  const po = await loadPurchaseOrder(client, tenantId, poId);
  const replies = (await client.query("select * from public.ordering_po_replies where tenant_id = $1 and purchase_order_id = $2 order by seq", [tenantId, poId])).rows.map(
    (r): PoReply => ({
      id: r.id,
      tenantId: r.tenant_id,
      purchaseOrderId: r.purchase_order_id,
      poLineId: r.po_line_id,
      kind: r.kind,
      quantity: r.quantity,
      ...(r.source === null ? {} : { source: r.source }),
      ...(r.eta === null ? {} : { eta: iso(r.eta).slice(0, 10) }),
      evidence: r.evidence,
      repliedAt: iso(r.replied_at),
      recordedAt: iso(r.recorded_at),
    }),
  );
  const requests = (await client.query("select * from public.ordering_po_cancellation_requests where tenant_id = $1 and purchase_order_id = $2", [tenantId, poId])).rows.map(
    (r): CancellationRequest => ({ id: r.id, tenantId: r.tenant_id, purchaseOrderId: r.purchase_order_id, poLineId: r.po_line_id, quantity: r.quantity, reason: r.reason, requestedAt: iso(r.requested_at) }),
  );
  const responses = (await client.query("select * from public.ordering_po_cancellation_responses where tenant_id = $1 and purchase_order_id = $2 order by recorded_at, id", [tenantId, poId])).rows.map(
    (r): CancellationResponse => ({ id: r.id, tenantId: r.tenant_id, purchaseOrderId: r.purchase_order_id, poLineId: r.po_line_id, requestId: r.request_id, acceptedQuantity: r.accepted_quantity, rejectedQuantity: r.rejected_quantity, evidence: r.evidence, repliedAt: iso(r.replied_at), recordedAt: iso(r.recorded_at) }),
  );
  const receipts = (await client.query("select * from public.ordering_goods_receipts where tenant_id = $1 and purchase_order_id = $2 order by recorded_at, id", [tenantId, poId])).rows.map(toReceipt);
  const receiptIds = receipts.map((r) => r.id);
  const corrections = (await client.query("select * from public.ordering_receipt_corrections where tenant_id = $1 and receipt_id = any($2::uuid[])", [tenantId, receiptIds])).rows.map(
    (c): ReceiptCorrection => ({ id: c.id, tenantId: c.tenant_id, receiptId: c.receipt_id, quantity: c.quantity, reason: c.reason, correctedBy: c.corrected_by, correctedAt: iso(c.corrected_at), recordedAt: iso(c.recorded_at) }),
  );
  const allocationIds = (await client.query("select id from public.ordering_receipt_allocations where tenant_id = $1 and receipt_id = any($2::uuid[])", [tenantId, receiptIds])).rows.map((r) => r.id as string);
  const ledger = await loadAllocationLedger(client, tenantId, allocationIds);
  return { po, replies, requests, responses, receipts, corrections, ...ledger };
}

type PoState = Awaited<ReturnType<typeof loadPoState>>;

/**
 * 검수 입고·고객별 배분·배분 해제를 Postgres 영속화 위에서 실행한다 (E7 권고안 a). 발주 품목 단위
 * 락(`pol:`)을 어댑터와 트리거가 같이 잡아 마지막 1권 동시 배분·동시 입고를 직렬화한다.
 * 발주 생성·전달·회신 명령은 아직 영속화하지 않았다(읽기 스키마만 있다).
 */
export function createPgReceivingApi(deps: { pool: PoolLike }) {
  /** 락 키를 정하려고 품목 ID를 찾고, 락을 잡은 뒤 발주 상태를 적재해 실행한다 */
  async function run<T, B extends { tenantId: string; idempotencyKey?: unknown }>(
    actor: Actor,
    request: B,
    find: (client: PoolClient) => Promise<{ poLineId?: string; poId?: string } | undefined>,
    execute: (ctx: { principal: ReturnType<typeof principalFor>; state: PoState | undefined; idempotency: Awaited<ReturnType<typeof loadCommands>> }) => T,
    flush: (client: PoolClient, result: T) => Promise<void>,
    /** 락을 잡은 뒤 추가로 적재할 기록(입고 후속 기록 등) */
    load?: (client: PoolClient) => Promise<void>,
  ): Promise<T> {
    return inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const found = isUuid(request.tenantId) ? await find(client) : undefined;
      let state: PoState | undefined;
      if (found?.poLineId && found.poId) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [polLockKey(request.tenantId, found.poLineId)]);
        state = await loadPoState(client, request.tenantId, found.poId);
      }
      if (found?.poLineId) await load?.(client);
      // 멱등 기록은 락을 잡은 뒤에 읽는다. 같은 키로 먼저 커밋된 요청의 결과를 봐야 재생으로 처리된다
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const result = execute({ principal, state, idempotency });
      await flush(client, result);
      await saveNewCommands(client, idempotency, known);
      return result;
    });
  }
  const forbidden = () => {
    throw new Error("this command must not write this ledger");
  };

  function receiptRepos(s: PoState | undefined, sink: { receipts: GoodsReceipt[]; allocations: ReceiptAllocation[]; releases: AllocationRelease[] }) {
    return {
      purchaseOrders: { get: (_t: string, id: string) => (s?.po && s.po.id === id ? s.po : undefined), list: () => (s?.po ? [s.po] : []), save: forbidden },
      receipts: {
        get: (_t: string, id: string) => s?.receipts.find((r) => r.id === id),
        list: (_t: string, poId: string) => (s?.receipts ?? []).filter((r) => r.purchaseOrderId === poId),
        save: (r: GoodsReceipt) => void sink.receipts.push(r),
      },
      receiptCorrections: { list: (_t: string, receiptId: string) => (s?.corrections ?? []).filter((c) => c.receiptId === receiptId), save: forbidden },
      replies: { list: (_t: string, poId: string) => (s?.replies ?? []).filter((r) => r.purchaseOrderId === poId), save: forbidden },
      cancellations: {
        getRequest: (_t: string, id: string) => s?.requests.find((r) => r.id === id),
        listRequests: (_t: string, poId: string) => (s?.requests ?? []).filter((r) => r.purchaseOrderId === poId),
        saveRequest: forbidden,
        listResponses: (_t: string, poId: string) => (s?.responses ?? []).filter((r) => r.purchaseOrderId === poId),
        saveResponse: forbidden,
      },
      receiptAllocations: {
        get: (_t: string, id: string) => s?.allocations.find((a) => a.id === id),
        listByOrder: (_t: string, orderId: string) => (s?.allocations ?? []).filter((a) => a.orderId === orderId),
        list: (_t: string, receiptId: string) => (s?.allocations ?? []).filter((a) => a.receiptId === receiptId),
        save: (a: ReceiptAllocation) => void sink.allocations.push(a),
      },
      allocationReleases: {
        list: (_t: string, allocationId: string) => (s?.releases ?? []).filter((r) => r.allocationId === allocationId),
        save: (r: AllocationRelease) => void sink.releases.push(r),
      },
      allocationDeliveries: { list: (_t: string, allocationId: string) => (s?.deliveries ?? []).filter((d) => d.allocationId === allocationId), save: forbidden },
      allocationCancellations: { list: (_t: string, allocationId: string) => (s?.cancellations ?? []).filter((c) => c.allocationId === allocationId) },
    };
  }

  const lookupReceipt = async (client: PoolClient, tenantId: string, receiptId: unknown) =>
    isUuid(receiptId)
      ? (await client.query("select purchase_order_id, po_line_id from public.ordering_goods_receipts where tenant_id = $1 and id = $2", [tenantId, receiptId])).rows[0]
      : undefined;

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

  const insertReceipt = (client: PoolClient, r: GoodsReceipt) =>
    client.query(
      "insert into public.ordering_goods_receipts (id, tenant_id, purchase_order_id, po_line_id, normal_quantity, excess_quantity, damaged_quantity, misdelivered_quantity, inspected_by, received_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [r.id, r.tenantId, r.purchaseOrderId, r.poLineId, r.normalQuantity, r.excessQuantity, r.damagedQuantity, r.misdeliveredQuantity, r.inspectedBy, r.receivedAt, r.recordedAt],
    );

  return {
    receiveGoods: (actor: Actor, request: ReceiveGoodsBody): Promise<GoodsReceipt> =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async () => (isUuid(request.poLineId) && isUuid(request.purchaseOrderId) ? { poLineId: request.poLineId, poId: request.purchaseOrderId } : undefined),
          (ctx) => authorizedActions.receiveGoods({ ...receiptRepos(ctx.state, sink), idempotency: ctx.idempotency }, ctx.principal, rest),
          async (client) => void (await Promise.all(sink.receipts.map((r) => insertReceipt(client, r)))),
        );
      }),
    resolveReceiptDefect: (actor: Actor, request: ResolveReceiptDefectBody): Promise<ReceiptDefectResolution> =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const saved: ReceiptDefectResolution[] = [];
        let existing: ReceiptDefectResolution[] = [];
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async (client) => {
            const r = await lookupReceipt(client, request.tenantId, request.receiptId);
            return r ? { poLineId: r.po_line_id, poId: r.purchase_order_id } : undefined;
          },
          (ctx) =>
            authorizedActions.resolveReceiptDefect(
              { receipts: { get: (_t2: string, id: string) => ctx.state?.receipts.find((r) => r.id === id) }, receiptDefectResolutions: { list: () => existing, save: (r) => void saved.push(r) }, idempotency: ctx.idempotency },
              ctx.principal,
              rest,
            ),
          async (client) => {
            for (const r of saved) {
              await client.query(
                "insert into public.ordering_receipt_defect_resolutions (id, tenant_id, receipt_id, purchase_order_id, kind, quantity, outcome, evidence, resolved_by, resolved_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
                [r.id, r.tenantId, r.receiptId, r.purchaseOrderId, r.kind, r.quantity, r.outcome, r.evidence, r.resolvedBy, r.resolvedAt, r.recordedAt],
              );
            }
          },
          async (client) => {
            existing = (await client.query("select * from public.ordering_receipt_defect_resolutions where tenant_id = $1 and receipt_id = $2", [request.tenantId, request.receiptId])).rows.map(
              (r): ReceiptDefectResolution => ({ id: r.id, tenantId: r.tenant_id, receiptId: r.receipt_id, purchaseOrderId: r.purchase_order_id, kind: r.kind, quantity: r.quantity, outcome: r.outcome, evidence: r.evidence, resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at), recordedAt: iso(r.recorded_at) }),
            );
          },
        );
      }),
    decideExcessReceipt: (actor: Actor, request: DecideExcessReceiptBody): Promise<ExcessDecision> =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const saved: ExcessDecision[] = [];
        let existing: ExcessDecision[] = [];
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async (client) => {
            const r = await lookupReceipt(client, request.tenantId, request.receiptId);
            return r ? { poLineId: r.po_line_id, poId: r.purchase_order_id } : undefined;
          },
          (ctx) =>
            authorizedActions.decideExcessReceipt(
              { receipts: receiptRepos(ctx.state, sink).receipts, excessDecisions: { list: () => existing, save: (d) => void saved.push(d) }, idempotency: ctx.idempotency },
              ctx.principal,
              rest,
            ),
          async (client) => {
            for (const d of saved) {
              await client.query("insert into public.ordering_excess_decisions (id, tenant_id, receipt_id, decision, quantity, reason, decided_by, decided_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [d.id, d.tenantId, d.receiptId, d.decision, d.quantity, d.reason, d.decidedBy, d.decidedAt, d.recordedAt]);
            }
          },
          async (client) => {
            existing = (await client.query("select * from public.ordering_excess_decisions where tenant_id = $1 and receipt_id = $2", [request.tenantId, request.receiptId])).rows.map(
              (d): ExcessDecision => ({ id: d.id, tenantId: d.tenant_id, receiptId: d.receipt_id, decision: d.decision, quantity: d.quantity, reason: d.reason, decidedBy: d.decided_by, decidedAt: iso(d.decided_at), recordedAt: iso(d.recorded_at) }),
            );
          },
        );
      }),
    correctReceipt: (actor: Actor, request: CorrectReceiptBody): Promise<ReceiptCorrection> =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const saved: ReceiptCorrection[] = [];
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async (client) => {
            const r = await lookupReceipt(client, request.tenantId, request.receiptId);
            return r ? { poLineId: r.po_line_id, poId: r.purchase_order_id } : undefined;
          },
          (ctx) => {
            const repos = receiptRepos(ctx.state, sink);
            return authorizedActions.correctReceipt(
              {
                receipts: repos.receipts,
                receiptAllocations: repos.receiptAllocations,
                allocationReleases: repos.allocationReleases,
                allocationDeliveries: repos.allocationDeliveries,
                receiptCorrections: { list: repos.receiptCorrections.list, save: (c: ReceiptCorrection) => void saved.push(c) },
                idempotency: ctx.idempotency,
              },
              ctx.principal,
              rest,
            );
          },
          async (client) => {
            for (const c of saved) {
              await client.query("insert into public.ordering_receipt_corrections (id, tenant_id, receipt_id, quantity, reason, corrected_by, corrected_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [c.id, c.tenantId, c.receiptId, c.quantity, c.reason, c.correctedBy, c.correctedAt, c.recordedAt]);
            }
          },
        );
      }),
    cancelAllocation: (actor: Actor, request: CancelAllocationBody): Promise<AllocationCancellation> =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const saved: AllocationCancellation[] = [];
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async (client) => {
            if (!isUuid(request.allocationId)) return undefined;
            const a = (await client.query("select receipt_id from public.ordering_receipt_allocations where tenant_id = $1 and id = $2", [request.tenantId, request.allocationId])).rows[0];
            const r = a ? await lookupReceipt(client, request.tenantId, a.receipt_id) : undefined;
            return r ? { poLineId: r.po_line_id, poId: r.purchase_order_id } : undefined;
          },
          (ctx) => {
            const repos = receiptRepos(ctx.state, sink);
            return authorizedActions.cancelAllocation(
              {
                receipts: repos.receipts,
                purchaseOrders: repos.purchaseOrders,
                receiptAllocations: repos.receiptAllocations,
                allocationReleases: repos.allocationReleases,
                allocationDeliveries: repos.allocationDeliveries,
                allocationCancellations: {
                  get: (_t2: string, id: string) => ctx.state?.cancellations.find((c) => c.id === id),
                  list: repos.allocationCancellations.list,
                  save: (c: AllocationCancellation) => void saved.push(c),
                },
                idempotency: ctx.idempotency,
              },
              ctx.principal,
              rest,
            );
          },
          async (client) => {
            for (const c of saved) {
              await client.query(
                "insert into public.ordering_allocation_cancellations (id, tenant_id, book_key, receipt_id, allocation_id, order_id, order_line_id, quantity, reason, cancelled_by, cancelled_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
                [c.id, c.tenantId, c.bookId, c.receiptId, c.allocationId, c.orderId, c.orderLineId, c.quantity, c.reason, c.cancelledBy, c.cancelledAt, c.recordedAt],
              );
            }
          },
        );
      }),
    reallocateAllocation: (actor: Actor, request: ReallocateAllocationBody) =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async (client) => {
            if (!isUuid(request.allocationId)) return undefined;
            const a = (await client.query("select receipt_id from public.ordering_receipt_allocations where tenant_id = $1 and id = $2", [request.tenantId, request.allocationId])).rows[0];
            const r = a ? await lookupReceipt(client, request.tenantId, a.receipt_id) : undefined;
            return r ? { poLineId: r.po_line_id, poId: r.purchase_order_id } : undefined;
          },
          (ctx) => authorizedActions.reallocateAllocation({ ...receiptRepos(ctx.state, sink), idempotency: ctx.idempotency }, ctx.principal, rest),
          async (client) => {
            // 해제와 새 배분은 한 트랜잭션에서 함께 저장한다
            for (const r of sink.releases) {
              await client.query("insert into public.ordering_allocation_releases (id, tenant_id, allocation_id, quantity, reason, released_by, released_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [r.id, r.tenantId, r.allocationId, r.quantity, r.reason, r.releasedBy, r.releasedAt, r.recordedAt]);
            }
            for (const a of sink.allocations) {
              await client.query(
                "insert into public.ordering_receipt_allocations (id, tenant_id, receipt_id, order_id, order_line_id, quantity, allocated_by, allocated_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                [a.id, a.tenantId, a.receiptId, a.orderId, a.orderLineId, a.quantity, a.allocatedBy, a.allocatedAt, a.recordedAt],
              );
            }
          },
        );
      }),
    allocateReceipt: (actor: Actor, request: AllocateReceiptBody): Promise<ReceiptAllocation> =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async (client) => {
            const r = await lookupReceipt(client, request.tenantId, request.receiptId);
            return r ? { poLineId: r.po_line_id, poId: r.purchase_order_id } : undefined;
          },
          (ctx) => authorizedActions.allocateReceipt({ ...receiptRepos(ctx.state, sink), idempotency: ctx.idempotency }, ctx.principal, rest),
          async (client) => {
            for (const a of sink.allocations) {
              await client.query(
                "insert into public.ordering_receipt_allocations (id, tenant_id, receipt_id, order_id, order_line_id, quantity, allocated_by, allocated_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                [a.id, a.tenantId, a.receiptId, a.orderId, a.orderLineId, a.quantity, a.allocatedBy, a.allocatedAt, a.recordedAt],
              );
            }
          },
        );
      }),
    releaseAllocation: (actor: Actor, request: ReleaseAllocationBody): Promise<AllocationRelease> =>
      withRetry(() => {
        const sink = { receipts: [] as GoodsReceipt[], allocations: [] as ReceiptAllocation[], releases: [] as AllocationRelease[] };
        const { tenantId: _t, ...rest } = request;
        void _t;
        return run(
          actor,
          request,
          async (client) => {
            if (!isUuid(request.allocationId)) return undefined;
            const a = (await client.query("select receipt_id from public.ordering_receipt_allocations where tenant_id = $1 and id = $2", [request.tenantId, request.allocationId])).rows[0];
            const r = a ? await lookupReceipt(client, request.tenantId, a.receipt_id) : undefined;
            return r ? { poLineId: r.po_line_id, poId: r.purchase_order_id } : undefined;
          },
          (ctx) => authorizedActions.releaseAllocation({ ...receiptRepos(ctx.state, sink), idempotency: ctx.idempotency }, ctx.principal, rest),
          async (client) => {
            for (const r of sink.releases) {
              await client.query(
                "insert into public.ordering_allocation_releases (id, tenant_id, allocation_id, quantity, reason, released_by, released_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
                [r.id, r.tenantId, r.allocationId, r.quantity, r.reason, r.releasedBy, r.releasedAt, r.recordedAt],
              );
            }
          },
        );
      }),
  };
}

