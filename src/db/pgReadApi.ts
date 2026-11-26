import type { PoolClient } from "pg";
import type { TemplateVersion } from "../catalog/messageTemplate";
import { normalizeIsbn, type Book, type BookRevision } from "../catalog/registerBook";
import { AppError } from "../errors/AppError";
import { longUnreceivedWarnings, type LongUnreceivedWarning } from "../notification/longUnreceivedWarnings";
import { notificationState, type NotificationStatus } from "../notification/notificationState";
import type { NotificationTarget } from "../notification/createNotificationTarget";
import type { NotificationAttempt } from "../notification/recordNotificationAttempt";
import type { NotificationResult } from "../notification/recordNotificationResult";
import type { StockLevel } from "../inventory/stockLevel";
import type { PurchaseOrder } from "../procurement/createPurchaseOrder";
import type { Supplier } from "../procurement/allocateSourcing";
import { toBook } from "./pgCatalogApi";
import { paymentSummary, type PaymentSummary } from "../payment/paymentSummary";
import type { Payment } from "../payment/recordPayment";
import { loadLedger, type PaymentLedger } from "./pgPaymentApi";
import { toSupplier } from "./pgSupplierApi";
import { loadSecuredDeps, toAttempt, toResult, toTarget } from "./pgNotificationApi";
import { inTransaction, isUuid, loadMembership, loadOrders, principalFor, type PoolLike } from "./pgSupport";

type Actor = { userId: string };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const validation = (message: string) => new AppError("VALIDATION_ERROR", message);

function pageSize(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw validation("limit must be an integer 1..100");
  return value;
}

/** 불투명 커서: 정렬 키 배열을 base64 JSON으로 감싼다. 형식이 맞지 않으면 400 */
const encodeCursor = (key: string[]) => btoa(unescape(encodeURIComponent(JSON.stringify(key))));
function decodeCursor(cursor: string, size: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(escape(atob(cursor))));
  } catch {
    throw validation("invalid cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== size || !parsed.every((p) => typeof p === "string")) throw validation("invalid cursor");
  return parsed as string[];
}

/** 안내 대상과 기록에서 파생한 상태(BR-M01) */
export type NotificationTargetView = NotificationTarget & {
  status: NotificationStatus;
  attemptCount: number;
  lastAttempt?: NotificationAttempt;
  lastResult?: NotificationResult;
};

export type ListMessageTemplatesRequest = { tenantId: string; key?: string };

const toTemplate = (v: any): TemplateVersion => ({
  id: v.id,
  tenantId: v.tenant_id,
  key: v.key,
  version: Number(v.version),
  body: v.body,
  variables: v.variables,
  publishedBy: v.published_by,
  publishedAt: v.published_at.toISOString(),
  recordedAt: v.recorded_at.toISOString(),
});

const toRevision = (r: any): BookRevision => ({
  id: r.id,
  tenantId: r.tenant_id,
  bookId: r.book_id,
  versionBefore: Number(r.version_before),
  versionAfter: Number(r.version_after),
  before: r.before,
  after: r.after,
  reason: r.reason,
  changedBy: r.changed_by,
  changedAt: r.changed_at.toISOString(),
});

const PO_STATUSES = ["DRAFT", "READY", "SENT", "ACKNOWLEDGED", "CANCELLED", "CLOSED"];

export type ListPurchaseOrdersRequest = { tenantId: string; limit?: number; cursor?: string; status?: string; supplierCode?: string };

/** 발주 행들에 품목·주문 연결을 붙여 도메인 객체로 만든다 */
async function toPurchaseOrders(client: PoolClient, tenantId: string, pos: any[]): Promise<PurchaseOrder[]> {
  const ids = pos.map((p) => p.id);
  const lines = (await client.query("select * from public.ordering_po_lines where tenant_id = $1 and purchase_order_id = any($2::uuid[]) order by id", [tenantId, ids])).rows;
  const links = (await client.query("select * from public.ordering_po_links where tenant_id = $1 and po_line_id = any($2::uuid[]) order by id", [tenantId, lines.map((l) => l.id)])).rows;
  return pos.map((po) => ({
    id: po.id,
    tenantId: po.tenant_id,
    supplierCode: po.supplier_code,
    status: po.status,
    version: Number(po.version),
    lines: lines
      .filter((l) => l.purchase_order_id === po.id)
      .map((l) => ({
        poLineId: l.id,
        bookId: l.book_key,
        quantity: l.quantity,
        links: links.filter((k) => k.po_line_id === l.id).map((k) => ({ allocationId: k.allocation_id, orderId: k.order_id, orderLineId: k.order_line_id, quantity: k.quantity })),
      })),
    ...(po.delivery === null ? {} : { delivery: po.delivery }),
    ...(po.cancelled_at === null ? {} : { cancelledAt: po.cancelled_at.toISOString() }),
    ...(po.cancelled_by === null ? {} : { cancelledBy: po.cancelled_by }),
    ...(po.cancel_reason === null ? {} : { cancelReason: po.cancel_reason }),
    ...(po.closed_at === null ? {} : { closedAt: po.closed_at.toISOString() }),
  }));
}

export type StockLevelView = { bookId: string } & StockLevel;

/** 원장에서 도서별 보유·예약·가용을 파생하는 쿼리(BR-Q09). `$1`은 서점, `$2`는 도서 키(없으면 전체), `$3`은 커서 키 */
const STOCK_LEVELS_SQL = `
  with keys as (
    select book_key from public.ordering_stock_movements where tenant_id = $1
    union
    select book_key from public.ordering_stock_reservations where tenant_id = $1
  )
  select k.book_key,
    coalesce((select sum(case m.direction when 'IN' then m.quantity else -m.quantity end) from public.ordering_stock_movements m where m.tenant_id = $1 and m.book_key = k.book_key), 0)::int as on_hand,
    (coalesce((select sum(r.quantity) from public.ordering_stock_reservations r where r.tenant_id = $1 and r.book_key = k.book_key), 0)
     - coalesce((select sum(x.quantity) from public.ordering_stock_reservation_releases x join public.ordering_stock_reservations r on r.tenant_id = x.tenant_id and r.id = x.reservation_id where x.tenant_id = $1 and r.book_key = k.book_key), 0)
     - coalesce((select sum(d.quantity) from public.ordering_stock_reservation_deliveries d join public.ordering_stock_reservations r on r.tenant_id = d.tenant_id and r.id = d.reservation_id where d.tenant_id = $1 and r.book_key = k.book_key), 0))::int as reserved
  from keys k
  where ($2::text is null or k.book_key = $2) and ($3::text is null or k.book_key > $3)
  order by k.book_key
  limit $4`;

const toStockLevel = (row: any): StockLevelView => ({ bookId: row.book_key, onHand: row.on_hand, reserved: row.reserved, available: row.on_hand - row.reserved });

/** 결제 거래의 상태: 무효 > 확인 > 대기 순으로 기록에서 파생한다 */
export type PaymentView = Payment & { status: "CONFIRMED" | "PENDING" | "VOIDED" };
export type OrderPaymentsView = {
  summary: PaymentSummary;
  payments: PaymentView[];
  confirmations: PaymentLedger["confirmations"];
  voids: PaymentLedger["voids"];
  corrections: PaymentLedger["corrections"];
  refundTasks: PaymentLedger["tasks"];
  refundRequests: PaymentLedger["requests"];
  refunds: PaymentLedger["refunds"];
};

export type AuditLogEntry = {
  seq: string;
  id: string;
  tenantId: string;
  actorId: string;
  operation: string;
  commandKey?: string;
  requestHash: string;
  targets: Record<string, string>;
  recordedAt: string;
};
/** 주문 보류·재개·폐기 이력의 한 줄 */
export type OrderEventView = { kind: "HOLD" | "RESUME" | "DISCARD"; reason?: string; by: string; at: string };
export type ListAuditLogRequest = { tenantId: string; limit?: number; cursor?: string; actorId?: string };

export type ListBooksRequest = { tenantId: string; limit?: number; cursor?: string; isbn?: string };

/**
 * 조회 전용 API. 쓰기 어댑터와 같은 규칙으로 매 요청 활성 멤버십을 DB에서 확인하고(Owner·직원 모두 읽을 수 있다),
 * 서점 범위의 행만 돌려준다. 페이지 크기는 기본 20·최대 100이고 커서는 불투명 문자열이다.
 */
export function createPgReadApi(deps: { pool: PoolLike; now?: () => Date }) {
  /** 멤버십을 확인한 뒤 읽기 전용으로 실행한다 */
  const asMember = <T>(actor: Actor, tenantId: string, run: (client: PoolClient) => Promise<T>): Promise<T> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      principalFor(await loadMembership(client, actor.userId, tenantId), actor.userId, tenantId);
      return run(client);
    });

  /** 다른 서점의 도서와 없는 도서는 같은 404다(존재 비노출) */
  async function requireBook(client: PoolClient, tenantId: string, bookId: string): Promise<Book> {
    const row = isUuid(bookId) ? (await client.query("select * from public.ordering_books where tenant_id = $1 and id = $2", [tenantId, bookId])).rows[0] : undefined;
    if (!row) throw new AppError("NOT_FOUND");
    return toBook(row);
  }

  return {
    getBook: (actor: Actor, request: { tenantId: string; bookId: string }): Promise<Book> =>
      asMember(actor, request.tenantId, (client) => requireBook(client, request.tenantId, request.bookId)),

    listBookRevisions: (actor: Actor, request: { tenantId: string; bookId: string }): Promise<BookRevision[]> =>
      asMember(actor, request.tenantId, async (client) => {
        await requireBook(client, request.tenantId, request.bookId);
        return (await client.query("select * from public.ordering_book_revisions where tenant_id = $1 and book_id = $2 order by version_after", [request.tenantId, request.bookId])).rows.map(toRevision);
      }),

    /** 키를 주면 그 템플릿의 모든 버전(오래된 순), 아니면 키별 최신 버전 */
    listMessageTemplates: (actor: Actor, request: ListMessageTemplatesRequest): Promise<TemplateVersion[]> =>
      asMember(actor, request.tenantId, async (client) => {
        if (request.key !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(request.key)) throw validation("invalid template key");
        const rows =
          request.key === undefined
            ? (await client.query("select distinct on (key) * from public.ordering_template_versions where tenant_id = $1 order by key, version desc", [request.tenantId])).rows
            : (await client.query("select * from public.ordering_template_versions where tenant_id = $1 and key = $2 order by version", [request.tenantId, request.key])).rows;
        return rows.map(toTemplate);
      }),

    listNotificationTargets: (actor: Actor, request: { tenantId: string; orderId: string }): Promise<NotificationTargetView[]> =>
      asMember(actor, request.tenantId, async (client) => {
        const [order] = await loadOrders(client, request.tenantId, { orderId: request.orderId });
        if (!order) throw new AppError("NOT_FOUND");
        const targets = (await client.query("select * from public.ordering_notification_targets where tenant_id = $1 and order_id = $2 order by recorded_at, id", [request.tenantId, order.id])).rows.map(toTarget);
        const ids = targets.map((t) => t.id);
        const attempts = (await client.query("select * from public.ordering_notification_attempts where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, ids])).rows.map(toAttempt);
        const results = (await client.query("select * from public.ordering_notification_results where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, ids])).rows.map(toResult);
        return targets.map((target): NotificationTargetView => {
          const mine = { attempts: attempts.filter((a) => a.targetId === target.id), results: results.filter((x) => x.targetId === target.id) };
          const lastAttempt = mine.attempts[mine.attempts.length - 1];
          const lastResult = mine.results[mine.results.length - 1];
          return { ...target, status: notificationState(mine), attemptCount: mine.attempts.length, ...(lastAttempt ? { lastAttempt } : {}), ...(lastResult ? { lastResult } : {}) };
        });
      }),

    /** 안내를 마친 뒤 기준일(기본 7일)이 지나도 확보분이 남은 주문 목록(DEC-07: 목록만, 자동 조치 없음) */
    longUnreceivedWarnings: (actor: Actor, request: { tenantId: string; thresholdDays?: number }): Promise<LongUnreceivedWarning[]> =>
      asMember(actor, request.tenantId, async (client) => {
        const thresholdDays = request.thresholdDays ?? 7;
        if (!Number.isInteger(thresholdDays) || thresholdDays < 1 || thresholdDays > 365) throw validation("thresholdDays must be an integer 1..365");
        const now = (deps.now ?? (() => new Date()))();
        // 안내 완료(MANUAL_RECORDED)가 기준일 이상 지난 주문만 후보로 좁힌 뒤, 그 주문들에 도메인 계산을 그대로 적용한다
        const candidates = (
          await client.query(
            `select distinct t.order_id from public.ordering_notification_results r
               join public.ordering_notification_targets t on t.tenant_id = r.tenant_id and t.id = r.target_id
              where r.tenant_id = $1 and r.outcome = 'MANUAL_RECORDED' and r.result_at <= $2::timestamptz - make_interval(days => $3)`,
            [request.tenantId, now.toISOString(), thresholdDays],
          )
        ).rows.map((r) => r.order_id as string);
        const warnings: LongUnreceivedWarning[] = [];
        for (const orderId of candidates) {
          const [order] = await loadOrders(client, request.tenantId, { orderId });
          if (!order) continue;
          const targets = (await client.query("select * from public.ordering_notification_targets where tenant_id = $1 and order_id = $2 order by recorded_at, id", [request.tenantId, orderId])).rows.map(toTarget);
          const ids = targets.map((t) => t.id);
          const attempts = (await client.query("select * from public.ordering_notification_attempts where tenant_id = $1 and target_id = any($2::uuid[])", [request.tenantId, ids])).rows.map(toAttempt);
          const results = (await client.query("select * from public.ordering_notification_results where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, ids])).rows.map(toResult);
          warnings.push(
            ...longUnreceivedWarnings(
              {
                ...(await loadSecuredDeps(client, request.tenantId, order)),
                orders: { list: () => [order] },
                notificationTargets: { list: () => targets },
                notificationAttempts: { list: (_t: string, id: string) => attempts.filter((a) => a.targetId === id) },
                notificationResults: { list: (_t: string, id: string) => results.filter((x) => x.targetId === id) },
              },
              request.tenantId,
              now,
              thresholdDays,
            ),
          );
        }
        return warnings.sort((a, b) => b.daysElapsed - a.daysElapsed || (a.orderId < b.orderId ? -1 : 1));
      }),

    /** 비활성 공급처도 포함해 코드순으로 돌려준다 */
    listSuppliers: (actor: Actor, request: { tenantId: string }): Promise<Supplier[]> =>
      asMember(actor, request.tenantId, async (client) =>
        (await client.query("select * from public.ordering_suppliers where tenant_id = $1 order by code", [request.tenantId])).rows.map((row) => toSupplier(row)!),
      ),

    getSupplier: (actor: Actor, request: { tenantId: string; code: string }): Promise<Supplier> =>
      asMember(actor, request.tenantId, async (client) => {
        const supplier = toSupplier((await client.query("select * from public.ordering_suppliers where tenant_id = $1 and code = $2", [request.tenantId, request.code])).rows[0]);
        if (!supplier) throw new AppError("NOT_FOUND");
        return supplier;
      }),

    getPurchaseOrder: (actor: Actor, request: { tenantId: string; purchaseOrderId: string }): Promise<PurchaseOrder> =>
      asMember(actor, request.tenantId, async (client) => {
        const row = isUuid(request.purchaseOrderId) ? (await client.query("select * from public.ordering_purchase_orders where tenant_id = $1 and id = $2", [request.tenantId, request.purchaseOrderId])).rows[0] : undefined;
        if (!row) throw new AppError("NOT_FOUND");
        return (await toPurchaseOrders(client, request.tenantId, [row]))[0]!;
      }),

    /** 최신순(생성 시각 내림차순). 상태·공급처로 거를 수 있다 */
    listPurchaseOrders: (actor: Actor, request: ListPurchaseOrdersRequest): Promise<{ items: PurchaseOrder[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        if (request.status !== undefined && !PO_STATUSES.includes(request.status)) throw validation("invalid status");
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        if (after && Number.isNaN(Date.parse(after[0]!))) throw validation("invalid cursor");
        if (after && !isUuid(after[1]!)) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select *, created_at::text as created_at_text from public.ordering_purchase_orders
              where tenant_id = $1
                and ($2::text is null or status = $2)
                and ($3::text is null or supplier_code = $3)
                and ($4::text is null or (created_at, id) < ($4::timestamptz, $5::uuid))
              order by created_at desc, id desc
              limit $6`,
            [request.tenantId, request.status ?? null, request.supplierCode ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { items: await toPurchaseOrders(client, request.tenantId, page), ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.created_at_text, last.id]) } : {}) };
      }),

    getStockLevel: (actor: Actor, request: { tenantId: string; bookId: string }): Promise<StockLevelView> =>
      asMember(actor, request.tenantId, async (client) => {
        const [row] = (await client.query(STOCK_LEVELS_SQL, [request.tenantId, request.bookId, null, 1])).rows;
        if (!row) throw new AppError("NOT_FOUND");
        return toStockLevel(row);
      }),

    /** 원장에 기록이 있는 도서의 재고 현황을 도서 키 순으로 읽는다 */
    listStockLevels: (actor: Actor, request: { tenantId: string; limit?: number; cursor?: string }): Promise<{ items: StockLevelView[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 1);
        const rows = (await client.query(STOCK_LEVELS_SQL, [request.tenantId, null, after?.[0] ?? null, limit + 1])).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { items: page.map(toStockLevel), ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.book_key]) } : {}) };
      }),

    /** 주문의 보류·재개·폐기 이력(오래된 순). 재개·폐기 뒤에도 사유가 남는다 */
    getOrderHistory: (actor: Actor, request: { tenantId: string; orderId: string }): Promise<OrderEventView[]> =>
      asMember(actor, request.tenantId, async (client) => {
        const [order] = await loadOrders(client, request.tenantId, { orderId: request.orderId });
        if (!order) throw new AppError("NOT_FOUND");
        const rows = (await client.query("select kind, reason, actor_id, occurred_at from public.ordering_order_events where tenant_id = $1 and order_id = $2 order by seq", [request.tenantId, order.id])).rows;
        return rows.map((r): OrderEventView => ({ kind: r.kind, ...(r.reason === null ? {} : { reason: r.reason }), by: r.actor_id, at: (r.occurred_at as Date).toISOString() }));
      }),

    /** 주문의 결제·환급 원장과 파생 요약. 결제 증빙은 민감 정보라 활성 멤버만 읽는다(RLS-03) */
    getOrderPayments: (actor: Actor, request: { tenantId: string; orderId: string }): Promise<OrderPaymentsView> =>
      asMember(actor, request.tenantId, async (client) => {
        const [order] = await loadOrders(client, request.tenantId, { orderId: request.orderId });
        if (!order) throw new AppError("NOT_FOUND");
        const l = await loadLedger(client, order);
        const voided = new Set(l.voids.map((v) => v.paymentId));
        const confirmed = new Set(l.confirmations.map((c) => c.paymentId));
        return {
          summary: paymentSummary(order, l.payments, l.confirmations, l.voids, l.refunds, l.corrections),
          payments: l.payments.map((p): PaymentView => ({ ...p, status: voided.has(p.id) ? "VOIDED" : confirmed.has(p.id) ? "CONFIRMED" : "PENDING" })),
          confirmations: l.confirmations,
          voids: l.voids,
          corrections: l.corrections,
          refundTasks: l.tasks,
          refundRequests: l.requests,
          refunds: l.refunds,
        };
      }),

    /** Owner 전용. 최신순(기록 순번 내림차순)이며 `actorId`로 거를 수 있다 */
    listAuditLog: (actor: Actor, request: ListAuditLogRequest): Promise<{ items: AuditLogEntry[]; nextCursor?: string }> =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
        if (principal.role !== "OWNER") throw new AppError("FORBIDDEN");
        const limit = pageSize(request.limit);
        if (request.actorId !== undefined && !isUuid(request.actorId)) throw validation("invalid actorId");
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 1);
        if (after && !/^\d{1,18}$/.test(after[0]!)) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select * from public.ordering_audit_log
              where tenant_id = $1 and ($2::uuid is null or actor_id = $2) and ($3::bigint is null or seq < $3)
              order by seq desc
              limit $4`,
            [request.tenantId, request.actorId ?? null, after?.[0] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const items = page.map(
          (r): AuditLogEntry => ({
            seq: String(r.seq),
            id: r.id,
            tenantId: r.tenant_id,
            actorId: r.actor_id,
            operation: r.operation,
            ...(r.command_key === null ? {} : { commandKey: r.command_key }),
            requestHash: r.request_hash,
            targets: r.targets,
            recordedAt: r.recorded_at.toISOString(),
          }),
        );
        return { items, ...(rows.length > limit && last ? { nextCursor: encodeCursor([String(last.seq)]) } : {}) };
      }),

    listBooks: (actor: Actor, request: ListBooksRequest): Promise<{ items: Book[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        const isbn = request.isbn === undefined ? undefined : normalizeIsbn(request.isbn);
        const rows = (
          await client.query(
            `select * from public.ordering_books
              where tenant_id = $1
                and ($2::text is null or isbn = $2)
                and ($3::text is null or (title, id::text) > ($3, $4))
              order by title, id
              limit $5`,
            [request.tenantId, isbn ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { items: page.map(toBook), ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.title, last.id]) } : {}) };
      }),
  };
}

