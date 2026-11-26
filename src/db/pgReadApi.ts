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
import { parseUtcTimestamp } from "../procurement/validation";
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
/** 입고 요약(O-07): 수량은 원장에서 파생한다. `normalQuantity`는 검수 등록 값, `correctedQuantity`는 검수 정정 합계 */
export type ReceiptSummary = {
  id: string;
  purchaseOrderId: string;
  poLineId: string;
  bookKey: string;
  receivedAt: string;
  normalQuantity: number;
  correctedQuantity: number;
  damagedQuantity: number;
  misdeliveredQuantity: number;
  excessQuantity: number;
  /** 배분 − 해제 */
  allocatedQuantity: number;
  /** (검수 − 정정) − 배분 + 해제 */
  unallocatedQuantity: number;
};
export type ReceiptDetail = ReceiptSummary & {
  allocations: { id: string; orderId: string; orderLineId: string; quantity: number; releasedQuantity: number; allocatedAt: string; allocatedBy: string }[];
  corrections: { id: string; quantity: number; reason: string; correctedAt: string; correctedBy: string }[];
  defectResolutions: { id: string; kind: "DAMAGED" | "MISDELIVERED"; quantity: number; outcome: "RETURNED_TO_SUPPLIER" | "SUPPLIER_CREDIT" | "DISCARDED"; resolvedAt: string; resolvedBy: string }[];
  excessDecisions: { id: string; decision: "APPROVED" | "REJECTED"; quantity: number; reason: string; decidedAt: string; decidedBy: string }[];
};
export type ListReceiptsRequest = { tenantId: string; limit?: number; cursor?: string; unallocated?: boolean; purchaseOrderId?: string };

/** 입고 요약 SELECT(서점 조건은 호출부가 where로 붙인다). 순서·미배분 필터는 바깥에서 건다 */
const RECEIPT_SUMMARY_SQL = `
  select g.id, g.purchase_order_id, g.po_line_id, l.book_key, g.received_at, g.received_at::text as received_at_text,
         g.normal_quantity, g.damaged_quantity, g.misdelivered_quantity, g.excess_quantity,
         c.corrected, a.allocated - a.released as allocated_quantity,
         g.normal_quantity - c.corrected - (a.allocated - a.released) as unallocated_quantity
    from public.ordering_goods_receipts g
    join public.ordering_po_lines l on l.tenant_id = g.tenant_id and l.id = g.po_line_id
    cross join lateral (select coalesce(sum(x.quantity), 0)::int as corrected from public.ordering_receipt_corrections x where x.tenant_id = g.tenant_id and x.receipt_id = g.id) c
    cross join lateral (
      select coalesce(sum(al.quantity), 0)::int as allocated,
             coalesce(sum((select coalesce(sum(r.quantity), 0) from public.ordering_allocation_releases r where r.tenant_id = al.tenant_id and r.allocation_id = al.id)), 0)::int as released
        from public.ordering_receipt_allocations al where al.tenant_id = g.tenant_id and al.receipt_id = g.id) a`;
const toReceiptSummary = (r: any): ReceiptSummary => ({
  id: r.id,
  purchaseOrderId: r.purchase_order_id,
  poLineId: r.po_line_id,
  bookKey: r.book_key,
  receivedAt: (r.received_at as Date).toISOString(),
  normalQuantity: r.normal_quantity,
  correctedQuantity: r.corrected,
  damagedQuantity: r.damaged_quantity,
  misdeliveredQuantity: r.misdelivered_quantity,
  excessQuantity: r.excess_quantity,
  allocatedQuantity: r.allocated_quantity,
  unallocatedQuantity: r.unallocated_quantity,
});

/** 서점 전체 안내 대기 큐(O-08)의 한 줄. 메시지 문구·결과 메모는 싣지 않는다 */
export type NotificationQueueItem = {
  id: string;
  orderId: string;
  orderDisplayNumber?: number;
  mode: "FULL" | "PARTIAL";
  securedTotal: number;
  status: NotificationStatus;
  createdAt: string;
  renoticeOfTargetId?: string;
  attemptedAt?: string;
  channel?: string;
  resultAt?: string;
  resultOutcome?: "MANUAL_RECORDED" | "FAILED";
  /** 주문에 연결된 고객(선택, 고객 결정 #4). 안내 연락에 필요해 번호 전체를 싣는다. 익명화되면 이름만 남고 번호는 null */
  customer?: { id: string; name: string; phone: string | null };
};
export type ListNotificationQueueRequest = { tenantId: string; limit?: number; cursor?: string; status?: NotificationStatus };
const NOTIFICATION_STATUSES: readonly NotificationStatus[] = ["PENDING", "ATTEMPTED", "MANUAL_RECORDED", "FAILED"];

/** 수령·결제 현황(O-09)의 한 줄: 확정 주문의 결제 요약과 수령 수량 */
export type OrderSettlement = {
  orderId: string;
  displayNumber?: number;
  totalKrw: string;
  confirmedKrw: string;
  pendingKrw: string;
  balanceKrw: string;
  refundRequiredKrw: string;
  orderedQuantity: number;
  deliveredQuantity: number;
  remainingQuantity: number;
};
export type ListOrderSettlementsRequest = { tenantId: string; limit?: number; cursor?: string; unpaid?: boolean; undelivered?: boolean; includeClosed?: boolean };

/** 환급 필요 업무 목록(O-09-04)의 한 줄. 증빙·사유 원문은 싣지 않는다 */
export type RefundTaskItem = {
  id: string;
  orderId: string;
  orderDisplayNumber?: number;
  requiredKrw: string;
  refundedKrw: string;
  remainingKrw: string;
  status: "REFUND_REQUIRED" | "PARTIAL" | "REFUNDED";
  openedAt: string;
  /** 승인·거절·철회가 아직 없는 환급 요청 수 */
  pendingRequests: number;
  /** 불명확(UNKNOWN) 결과를 보고했지만 아직 해소하지 않은 시도 수. 한도를 예약한다 */
  unresolvedAttempts: number;
};
export type ListRefundTasksRequest = { tenantId: string; limit?: number; cursor?: string; status?: RefundTaskItem["status"]; open?: boolean };
const REFUND_TASK_STATUSES: readonly RefundTaskItem["status"][] = ["REFUND_REQUIRED", "PARTIAL", "REFUNDED"];

/**
 * 전달된(SENT·ACKNOWLEDGED) 발주의 품목별 상태 SELECT. 서점은 $1이다. 대시보드의 부분입고·지연 카드와 공급처별 현황이 같이 쓴다.
 * remaining = max(0, 유효 수량 − 순입고), 유효 수량 = 발주 − 품절 회신 − 수락된 취소, 순입고 = 검수 정상 − 검수 정정(입고 가드 007과 같은 규칙).
 */
const PO_OPEN_LINE_SQL = `
               select l.id as po_line_id, p.supplier_code, greatest(l.quantity
                                     - coalesce((select sum(y.quantity) from public.ordering_po_replies y where y.tenant_id = l.tenant_id and y.po_line_id = l.id and y.kind = 'OUT_OF_STOCK'), 0)
                                     - coalesce((select sum(s.accepted_quantity) from public.ordering_po_cancellation_responses s where s.tenant_id = l.tenant_id and s.po_line_id = l.id), 0)
                                     - (coalesce((select sum(g.normal_quantity) from public.ordering_goods_receipts g where g.tenant_id = l.tenant_id and g.po_line_id = l.id), 0)
                                        - coalesce((select sum(c.quantity) from public.ordering_receipt_corrections c join public.ordering_goods_receipts g on g.tenant_id = c.tenant_id and g.id = c.receipt_id where g.tenant_id = l.tenant_id and g.po_line_id = l.id), 0)), 0) as remaining,
                            coalesce((select sum(g.normal_quantity) from public.ordering_goods_receipts g where g.tenant_id = l.tenant_id and g.po_line_id = l.id), 0)
                            - coalesce((select sum(c.quantity) from public.ordering_receipt_corrections c join public.ordering_goods_receipts g on g.tenant_id = c.tenant_id and g.id = c.receipt_id where g.tenant_id = l.tenant_id and g.po_line_id = l.id), 0) as net_received,
                            (p.delivery->>'deliveredAt')::timestamptz as delivered_at
                       from public.ordering_po_lines l
                       join public.ordering_purchase_orders p on p.tenant_id = l.tenant_id and p.id = l.purchase_order_id
                      where l.tenant_id = $1 and p.status in ('SENT', 'ACKNOWLEDGED')`;

/**
 * 취소 물량(배분 취소)별 처분 상태 SELECT(서점 조건은 호출부가 where로 붙인다). 처분 현황 목록과 대시보드 카드가 같이 쓴다.
 * pending = 취소 − 편입 − 반품 요청 + 거절 + 회수, held = 요청 − 거절 − 출고, dispatched = 출고 − 완료 − 예외 해소, final = 완료 + 최종 반송
 */
const ALLOCATION_CANCELLATION_SQL = `
               select c.id, c.receipt_id, c.order_id, c.order_line_id, l.book_key, c.quantity, c.cancelled_at, c.cancelled_at::text as cancelled_at_text,
                      c.quantity - v.intake - v.requested + v.rejected + v.recovered as pending,
                      v.intake as transferred,
                      v.requested - v.rejected - v.dispatched as held,
                      v.dispatched - v.completed - v.recovered - v.returned_final as dispatched,
                      v.completed + v.returned_final as final
                 from public.ordering_allocation_cancellations c
                 join public.ordering_goods_receipts g on g.tenant_id = c.tenant_id and g.id = c.receipt_id
                 join public.ordering_po_lines l on l.tenant_id = g.tenant_id and l.id = g.po_line_id
                 cross join lateral (
                   select coalesce((select sum(i.quantity) from public.ordering_stock_intakes i where i.tenant_id = c.tenant_id and i.cancellation_id = c.id), 0)::int as intake,
                          coalesce((select sum(r.quantity) from public.ordering_return_requests r where r.tenant_id = c.tenant_id and r.cancellation_id = c.id), 0)::int as requested,
                          coalesce((select sum(p.rejected_quantity) from public.ordering_return_replies p join public.ordering_return_requests r on r.tenant_id = p.tenant_id and r.id = p.return_request_id where r.tenant_id = c.tenant_id and r.cancellation_id = c.id), 0)::int as rejected,
                          coalesce((select sum(d.quantity) from public.ordering_return_dispatches d join public.ordering_return_requests r on r.tenant_id = d.tenant_id and r.id = d.return_request_id where r.tenant_id = c.tenant_id and r.cancellation_id = c.id), 0)::int as dispatched,
                          coalesce((select sum(m.quantity) from public.ordering_return_completions m join public.ordering_return_requests r on r.tenant_id = m.tenant_id and r.id = m.return_request_id where r.tenant_id = c.tenant_id and r.cancellation_id = c.id), 0)::int as completed,
                          coalesce((select sum(s.quantity) from public.ordering_return_exception_resolutions s join public.ordering_return_exceptions e on e.tenant_id = s.tenant_id and e.id = s.return_exception_id join public.ordering_return_requests r on r.tenant_id = e.tenant_id and r.id = e.return_request_id where r.tenant_id = c.tenant_id and r.cancellation_id = c.id and s.outcome = 'RECOVERED'), 0)::int as recovered,
                          coalesce((select sum(s.quantity) from public.ordering_return_exception_resolutions s join public.ordering_return_exceptions e on e.tenant_id = s.tenant_id and e.id = s.return_exception_id join public.ordering_return_requests r on r.tenant_id = e.tenant_id and r.id = e.return_request_id where r.tenant_id = c.tenant_id and r.cancellation_id = c.id and s.outcome = 'RETURNED'), 0)::int as returned_final
                 ) v`;

/** 취소 물량 처분 현황(R-01·R-03)의 한 줄. 다섯 수량의 합은 취소 수량과 같다 */
export type AllocationCancellationItem = {
  id: string;
  receiptId: string;
  orderId: string;
  orderLineId: string;
  bookKey: string;
  quantity: number;
  cancelledAt: string;
  /** 처분을 기다리는 수량(재고 편입·반품 요청 전, 반품 거절·회수로 돌아온 것 포함) */
  pendingDispositionQuantity: number;
  stockTransferredQuantity: number;
  returnHeldQuantity: number;
  returnDispatchedQuantity: number;
  returnedFinalQuantity: number;
};
export type ListAllocationCancellationsRequest = { tenantId: string; limit?: number; cursor?: string; open?: boolean };

/** 예외 업무 큐(O-01-01)의 유형 */
export const EXCEPTION_TYPES = ["EXCESS_RECEIPT", "UNCONFIRMED_PAYMENT", "REFUND_REQUIRED", "FAILED_NOTIFICATION", "PO_CANCELLATION_UNANSWERED"] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
/** 예외 업무 큐의 한 줄: 해결되지 않은 예외 하나. `refId`는 원인 대상(입고·결제·환급 업무·안내 대상·발주 취소 요청)의 ID다 */
export type ExceptionItem = {
  type: ExceptionType;
  refId: string;
  occurredAt: string;
  orderId?: string;
  orderDisplayNumber?: number;
  /** 초과 입고는 결정되지 않은 수량, 발주 취소 요청 미응답은 미응답 수량 */
  quantity?: number;
  /** 미확인 결제는 결제 금액, 환급 필요는 남은 환급액(정수 문자열) */
  amountKrw?: string;
};
export type ListExceptionsRequest = { tenantId: string; limit?: number; cursor?: string; type?: ExceptionType };

/** 공급처별 발주·입고 현황(DASH-006)의 한 줄 */
export type SupplierOverviewItem = {
  code: string;
  name?: string;
  active: boolean;
  orderChannel?: string;
  /** 발주 상태별 건수 */
  purchaseOrders: { draft: number; ready: number; sent: number; acknowledged: number; cancelled: number; closed: number };
  /** 전달된(SENT·ACKNOWLEDGED) 발주 품목의 잔량 합계(권): 유효 수량 − 순입고 */
  openRemainingQuantity: number;
  /** 전달한 지 delayDays일이 지나도 잔량이 남은 품목 수와 그 잔량 합계 */
  delayedLines: number;
  delayedQuantity: number;
  /** 이 공급처에 마지막으로 발주를 전달한 시각. 전달한 적이 없으면 없다 */
  lastDeliveredAt?: string;
};

/** 시간대별 통계(DASH-007)의 한 칸 묶음: 기초 단위(건수·수량(권)·금액(원, 정수 문자열))의 합 */
export type HourlyMeasures = {
  /** 작성된 주문(폐기된 초안 제외): 건수와 품목 수량(권) 합 */
  orders: { count: number; quantity: number };
  /** 확인된 결제(무효 제외)를 결제 시각으로: 건수와 금액(원) */
  payments: { count: number; amountKrw: string };
  /** 검수한 정상 입고 수량(권): 검수 시각에 더하고 검수 정정은 정정 시각에 뺀다 */
  receipts: { quantity: number };
  /** 고객 수령 수량(권): 수령 시각에 더하고 정정 역거래는 그 기록 시각에 뺀다 */
  deliveries: { quantity: number };
};
export type HourlyStatistics = {
  timezone: "Asia/Seoul";
  from: string;
  to: string;
  /** 영업 시간 09:00~22:00을 1시간 간격으로 나눈 13칸(hour 9..21) */
  hours: ({ hour: number; label: string } & HourlyMeasures)[];
  /** 영업 시간 밖(09:00 전·22:00 이후)의 같은 기간 업무 합계 */
  outsideBusinessHours: HourlyMeasures;
};
export const BUSINESS_FIRST_HOUR = 9;
export const BUSINESS_END_HOUR = 22;
const STATISTICS_TIMEZONE = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 3_600_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function parseDate(field: string, value: unknown): number {
  const ms = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms) || isoDate(ms) !== value) throw validation(`${field} must be a calendar date YYYY-MM-DD`);
  return ms;
}

/** 대시보드(O-01) 서버 집계 */
export type Dashboard = {
  orders: { draft: number; held: number; discarded: number; confirmed: number };
  purchaseOrders: { draft: number; ready: number; sent: number; acknowledged: number };
  refunds: { required: number; partial: number; remainingKrw: string };
  /** 미배분 입고(DASH-008): 미배분량이 남은 입고 수와 그 합계(권). 취소 후속 처리(처분 대기)는 아직 집계하지 않는다 */
  receipts: { unallocatedReceipts: number; unallocatedQuantity: number };
  /** 취소 후속 처리(DASH-008): 처분이 끝나지 않은 취소 물량 수와 처분 대기·반품 보관·반품 출고 수량 합계 */
  dispositions: { openCancellations: number; pendingQuantity: number; heldQuantity: number; dispatchedQuantity: number };
  /** 부분입고·미입고 잔량(DASH-003): 전달된 발주 품목 중 아직 다 들어오지 않은 것. 잔량 = 유효 수량(발주 − 품절 − 수락된 취소) − 순입고 */
  procurement: { notReceivedLines: number; partiallyReceivedLines: number; remainingQuantity: number; delayedLines: number; delayedQuantity: number };
  // delayedLines·delayedQuantity: 전달한 지 delayDays(기본 7)일이 지나도 잔량이 남은 품목 수와 잔량 합계(DASH-002 발주 지연)
  /** 미결제(DASH-005): 잔액이 남은 확정 주문 수, 잔액 합계(정수 문자열), 확인도 무효도 아닌 거래 수 */
  payments: { unpaidOrders: number; balanceKrw: string; unconfirmedPayments: number };
  /** 안내 대상(재안내로 대체된 것·완료된 것 제외): 대기(시도 없음)·시도만(결과 없음)·실패(재안내 필요) */
  notifications: { pending: number; attempted: number; failed: number };
  longUnreceivedWarnings: number;
  receivedSince?: number;
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

  const api = {
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
        // 기준일을 보내지 않으면 서점의 설정값(S-07, 기본 7일)을 쓴다. 명시한 값이 우선한다
        const thresholdDays =
          request.thresholdDays ?? Number((await client.query("select long_unreceived_warning_days as d from public.ordering_tenants where id = $1", [request.tenantId])).rows[0]?.d ?? 7);
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

    /**
     * 시간대별 기간 통계(DASH-007): 영업 시간 **09:00~22:00을 1시간 간격 13칸**으로, 서점 현지 시각(Asia/Seoul, UTC+9)의 `from`~`to`(날짜, 양 끝 포함) 기간 업무량을
     * **기초 단위**(건수·수량(권)·금액(원))로 합산한다(여러 날을 시각 칸별로 합친다). 영업 시간 밖 업무는 `outsideBusinessHours`에 따로 합산해 기간 합계와 맞춘다.
     * `from`·`to`를 생략하면 현지 오늘까지 최근 30일. 기간은 최대 366일. 기준 시각: 주문 작성, 결제 시각(확인된 결제), 검수·정정 시각, 수령·정정 시각.
     */
    getHourlyStatistics: (actor: Actor, request: { tenantId: string; from?: string; to?: string }): Promise<HourlyStatistics> =>
      asMember(actor, request.tenantId, async (client) => {
        const now = (deps.now ?? (() => new Date()))();
        const today = isoDate(now.getTime() + KST_OFFSET_MS);
        const toMs = request.to === undefined ? parseDate("to", today) : parseDate("to", request.to);
        const fromMs = request.from === undefined ? toMs - 29 * 86_400_000 : parseDate("from", request.from);
        if (fromMs > toMs) throw validation("from must not be after to");
        if ((toMs - fromMs) / 86_400_000 > 365) throw validation("the period must be at most 366 days");
        const from = isoDate(fromMs);
        const to = isoDate(toMs);
        const rows = (
          await client.query(
            `with b as (select ($2::date::timestamp at time zone '${STATISTICS_TIMEZONE}') as t0, (($3::date + 1)::timestamp at time zone '${STATISTICS_TIMEZONE}') as t1),
                  ev as (
                    select 'orders' as kind, extract(hour from o.created_at at time zone '${STATISTICS_TIMEZONE}')::int as hour, 1 as n,
                           coalesce((select sum(l.quantity) from public.ordering_order_lines l where l.tenant_id = o.tenant_id and l.order_id = o.id), 0) as amount
                      from public.ordering_orders o, b where o.tenant_id = $1 and o.discarded_at is null and o.created_at >= b.t0 and o.created_at < b.t1
                    union all
                    select 'payments', extract(hour from p.paid_at at time zone '${STATISTICS_TIMEZONE}')::int, 1, p.amount_krw
                      from public.ordering_payments p, b
                     where p.tenant_id = $1 and p.paid_at >= b.t0 and p.paid_at < b.t1
                       and exists (select 1 from public.ordering_payment_confirmations c where c.tenant_id = p.tenant_id and c.payment_id = p.id)
                       and not exists (select 1 from public.ordering_payment_voids v where v.tenant_id = p.tenant_id and v.payment_id = p.id)
                    union all
                    select 'receipts', extract(hour from g.received_at at time zone '${STATISTICS_TIMEZONE}')::int, 0, g.normal_quantity
                      from public.ordering_goods_receipts g, b where g.tenant_id = $1 and g.received_at >= b.t0 and g.received_at < b.t1
                    union all
                    select 'receipts', extract(hour from c.corrected_at at time zone '${STATISTICS_TIMEZONE}')::int, 0, -c.quantity
                      from public.ordering_receipt_corrections c, b where c.tenant_id = $1 and c.corrected_at >= b.t0 and c.corrected_at < b.t1
                    union all
                    select 'deliveries', extract(hour from f.received_at at time zone '${STATISTICS_TIMEZONE}')::int, 0, f.quantity
                      from public.ordering_fulfillments f, b where f.tenant_id = $1 and f.received_at >= b.t0 and f.received_at < b.t1)
             select kind, hour, sum(n)::int as n, sum(amount)::text as amount from ev group by kind, hour`,
            [request.tenantId, from, to],
          )
        ).rows;
        const empty = (): HourlyMeasures => ({ orders: { count: 0, quantity: 0 }, payments: { count: 0, amountKrw: "0" }, receipts: { quantity: 0 }, deliveries: { quantity: 0 } });
        const add = (m: HourlyMeasures, kind: string, n: number, amount: bigint) => {
          if (kind === "orders") m.orders = { count: m.orders.count + n, quantity: m.orders.quantity + Number(amount) };
          else if (kind === "payments") m.payments = { count: m.payments.count + n, amountKrw: (BigInt(m.payments.amountKrw) + amount).toString() };
          else if (kind === "receipts") m.receipts = { quantity: m.receipts.quantity + Number(amount) };
          else m.deliveries = { quantity: m.deliveries.quantity + Number(amount) };
        };
        const hours = Array.from({ length: BUSINESS_END_HOUR - BUSINESS_FIRST_HOUR }, (_, i) => BUSINESS_FIRST_HOUR + i).map((hour) => ({
          hour,
          label: `${String(hour).padStart(2, "0")}:00-${String(hour + 1).padStart(2, "0")}:00`,
          ...empty(),
        }));
        const outsideBusinessHours = empty();
        for (const r of rows) {
          const target = hours.find((h) => h.hour === r.hour) ?? outsideBusinessHours;
          add(target, r.kind, r.n, BigInt(String(r.amount)));
        }
        return { timezone: STATISTICS_TIMEZONE, from, to, hours, outsideBusinessHours };
      }),

    /**
     * 공급처별 발주·입고 현황(DASH-006): 서점의 공급처(비활성 포함)를 코드순으로, 발주 상태별 건수와 전달된 발주 품목의 잔량·지연·마지막 전달 시각을 돌려준다.
     * 잔량·지연은 대시보드와 같은 규칙이다(`delayDays` 기본 7일, 전달 후 경과일 기준). 공급처 수는 많지 않다고 보고 페이지네이션하지 않는다.
     */
    listSupplierOverview: (actor: Actor, request: { tenantId: string; delayDays?: number }): Promise<{ items: SupplierOverviewItem[] }> =>
      asMember(actor, request.tenantId, async (client) => {
        const now = (deps.now ?? (() => new Date()))();
        const delayDays = request.delayDays ?? 7;
        if (!Number.isInteger(delayDays) || delayDays < 1 || delayDays > 365) throw validation("delayDays must be an integer 1..365");
        const cutoff = new Date(now.getTime() - delayDays * 86_400_000).toISOString();
        const suppliers = (await client.query("select code, name, active, order_channel from public.ordering_suppliers where tenant_id = $1 order by code", [request.tenantId])).rows;
        const counts = (
          await client.query(
            `select supplier_code, status, count(*)::int as n, max((delivery->>'deliveredAt')::timestamptz) as last_delivered
               from public.ordering_purchase_orders where tenant_id = $1 group by supplier_code, status`,
            [request.tenantId],
          )
        ).rows;
        const open = (
          await client.query(
            `select supplier_code,
                    coalesce(sum(remaining) filter (where remaining > 0), 0)::int as remaining,
                    count(*) filter (where remaining > 0 and delivered_at <= $2::timestamptz)::int as delayed,
                    coalesce(sum(remaining) filter (where remaining > 0 and delivered_at <= $2::timestamptz), 0)::int as delayed_quantity
               from (${PO_OPEN_LINE_SQL}) x group by supplier_code`,
            [request.tenantId, cutoff],
          )
        ).rows;
        const items = suppliers.map((s): SupplierOverviewItem => {
          const mine = counts.filter((c) => c.supplier_code === s.code);
          const n = (status: string) => mine.find((c) => c.status === status)?.n ?? 0;
          const lastDelivered = mine.reduce<Date | undefined>((latest, c) => (c.last_delivered && (!latest || c.last_delivered > latest) ? (c.last_delivered as Date) : latest), undefined);
          const o = open.find((r) => r.supplier_code === s.code);
          return {
            code: s.code,
            ...(s.name === null ? {} : { name: s.name }),
            active: s.active,
            ...(s.order_channel === null ? {} : { orderChannel: s.order_channel }),
            purchaseOrders: { draft: n("DRAFT"), ready: n("READY"), sent: n("SENT"), acknowledged: n("ACKNOWLEDGED"), cancelled: n("CANCELLED"), closed: n("CLOSED") },
            openRemainingQuantity: o?.remaining ?? 0,
            delayedLines: o?.delayed ?? 0,
            delayedQuantity: o?.delayed_quantity ?? 0,
            ...(lastDelivered ? { lastDeliveredAt: lastDelivered.toISOString() } : {}),
          };
        });
        return { items };
      }),

    /**
     * 예외 업무 큐(O-01-01): 아직 해결되지 않은 예외를 최신 발생 순으로 한 목록에. 유형 — 초과 입고(결정되지 않은 수량), 미확인 결제(확인도 무효도 아님),
     * 환급 필요(환급 업무의 남은 금액), 안내 실패(마지막 결과가 실패이고 재안내 없음), 공급처 취소 요청 미응답(미응답 수량).
     * 대시보드의 같은 건수와 같은 규칙이다. 읽기 전용이며 임의 종결 경로는 없다(DEC-16). 장기 미수령은 `longUnreceivedWarnings`가 따로 다룬다.
     */
    listExceptions: (actor: Actor, request: ListExceptionsRequest): Promise<{ items: ExceptionItem[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        if (request.type !== undefined && !EXCEPTION_TYPES.includes(request.type)) throw validation("invalid type");
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        if (after && (Number.isNaN(Date.parse(after[0]!)) || !isUuid(after[1]!))) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select s.*, s.occurred_at::text as occurred_at_text from (
               select 'EXCESS_RECEIPT' as type, g.id as ref_id, g.received_at as occurred_at, null::uuid as order_id, null::bigint as display_number,
                      (g.excess_quantity - x.decided)::int as quantity, null::bigint as amount
                 from public.ordering_goods_receipts g
                 cross join lateral (select coalesce(sum(d.quantity), 0) as decided from public.ordering_excess_decisions d where d.tenant_id = g.tenant_id and d.receipt_id = g.id) x
                where g.tenant_id = $1 and g.excess_quantity > x.decided
               union all
               select 'UNCONFIRMED_PAYMENT', p.id, p.paid_at, p.order_id, o.display_number, null::int, p.amount_krw
                 from public.ordering_payments p join public.ordering_orders o on o.tenant_id = p.tenant_id and o.id = p.order_id
                where p.tenant_id = $1
                  and not exists (select 1 from public.ordering_payment_confirmations c where c.tenant_id = p.tenant_id and c.payment_id = p.id)
                  and not exists (select 1 from public.ordering_payment_voids v where v.tenant_id = p.tenant_id and v.payment_id = p.id)
               union all
               select 'REFUND_REQUIRED', k.id, k.opened_at, k.order_id, o.display_number, null::int, k.required_krw - x.refunded
                 from public.ordering_refund_tasks k join public.ordering_orders o on o.tenant_id = k.tenant_id and o.id = k.order_id
                 cross join lateral (select coalesce(sum(c.amount_krw), 0) as refunded from public.ordering_refund_confirmations c where c.tenant_id = k.tenant_id and c.refund_task_id = k.id) x
                where k.tenant_id = $1 and x.refunded < k.required_krw
               union all
               select 'FAILED_NOTIFICATION', t.id, r.result_at, t.order_id, o.display_number, null::int, null::bigint
                 from public.ordering_notification_targets t
                 join public.ordering_orders o on o.tenant_id = t.tenant_id and o.id = t.order_id
                 join lateral (select x.outcome, x.result_at from public.ordering_notification_results x where x.tenant_id = t.tenant_id and x.target_id = t.id order by x.recorded_at desc, x.id desc limit 1) r on true
                where t.tenant_id = $1 and r.outcome = 'FAILED'
                  and not exists (select 1 from public.ordering_notification_targets n where n.tenant_id = t.tenant_id and n.renotice_of_target_id = t.id)
               union all
               select 'PO_CANCELLATION_UNANSWERED', q.id, q.requested_at, null::uuid, null::bigint, (q.quantity - x.answered)::int, null::bigint
                 from public.ordering_po_cancellation_requests q
                 cross join lateral (select coalesce(sum(s.accepted_quantity + s.rejected_quantity), 0) as answered from public.ordering_po_cancellation_responses s where s.tenant_id = q.tenant_id and s.request_id = q.id) x
                where q.tenant_id = $1 and x.answered < q.quantity) s
              where ($2::text is null or s.type = $2)
                and ($3::text is null or (s.occurred_at, s.ref_id) < ($3::timestamptz, $4::uuid))
              order by s.occurred_at desc, s.ref_id desc
              limit $5`,
            [request.tenantId, request.type ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const items = page.map((r): ExceptionItem => ({
          type: r.type,
          refId: r.ref_id,
          occurredAt: (r.occurred_at as Date).toISOString(),
          ...(r.order_id === null ? {} : { orderId: r.order_id }),
          ...(r.display_number === null ? {} : { orderDisplayNumber: Number(r.display_number) }),
          ...(r.quantity === null ? {} : { quantity: r.quantity }),
          ...(r.amount === null ? {} : { amountKrw: BigInt(String(r.amount)).toString() }),
        }));
        return { items, ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.occurred_at_text, last.ref_id]) } : {}) };
      }),

    /**
     * 취소 물량 처분 현황(R-01·R-03): 취소로 풀린 배분 물량을 최근 취소 순으로. 취소 물량마다 8버킷 중 처분 대기·재고 편입·반품 보관·반품 출고·반품 완료를
     * 원장에서 파생한다(`receiptBuckets`의 이동 규칙): 대기 = 취소 − 편입 − 반품 요청 + 거절 + 회수, 보관 = 요청 − 거절 − 출고,
     * 출고 = 출고 − 완료 − 예외 해소(회수·최종 반송), 완료 = 완료 + 최종 반송. `open=true`는 처분이 끝나지 않은(대기·보관·출고가 남은) 물량만.
     */
    listAllocationCancellations: (actor: Actor, request: ListAllocationCancellationsRequest): Promise<{ items: AllocationCancellationItem[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        if (request.open !== undefined && typeof request.open !== "boolean") throw validation("open must be a boolean");
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        if (after && (Number.isNaN(Date.parse(after[0]!)) || !isUuid(after[1]!))) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select * from (
               ${ALLOCATION_CANCELLATION_SQL}
                where c.tenant_id = $1) s
              where ($2::boolean is not true or s.pending + s.held + s.dispatched > 0)
                and ($3::text is null or (s.cancelled_at, s.id) < ($3::timestamptz, $4::uuid))
              order by s.cancelled_at desc, s.id desc
              limit $5`,
            [request.tenantId, request.open === true ? true : null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const items = page.map((r): AllocationCancellationItem => ({
          id: r.id,
          receiptId: r.receipt_id,
          orderId: r.order_id,
          orderLineId: r.order_line_id,
          bookKey: r.book_key,
          quantity: r.quantity,
          cancelledAt: (r.cancelled_at as Date).toISOString(),
          pendingDispositionQuantity: r.pending,
          stockTransferredQuantity: r.transferred,
          returnHeldQuantity: r.held,
          returnDispatchedQuantity: r.dispatched,
          returnedFinalQuantity: r.final,
        }));
        return { items, ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.cancelled_at_text, last.id]) } : {}) };
      }),

    /**
     * 환급 필요 업무 목록(O-09-04): 서점의 환급 업무를 최신 개시 순으로. 상태·잔량은 환급 확인 합계에서 파생한다(`refundTaskState`와 같은 규칙:
     * 0이면 REFUND_REQUIRED, 남으면 PARTIAL, 다 하면 REFUNDED). `open=true`는 완료되지 않은 업무만, `status`로도 거를 수 있다.
     * 미결 요청 수(결정이 없는 요청)와 미해소 시도 수(해소가 없는 UNKNOWN 시도)를 함께 돌려준다. 증빙·사유 원문은 싣지 않는다.
     */
    listRefundTasks: (actor: Actor, request: ListRefundTasksRequest): Promise<{ items: RefundTaskItem[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        if (request.status !== undefined && !REFUND_TASK_STATUSES.includes(request.status)) throw validation("invalid status");
        if (request.open !== undefined && typeof request.open !== "boolean") throw validation("open must be a boolean");
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        if (after && (Number.isNaN(Date.parse(after[0]!)) || !isUuid(after[1]!))) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select * from (
               select k.id, k.order_id, o.display_number, k.required_krw, k.opened_at, k.opened_at::text as opened_at_text, x.refunded,
                      case when x.refunded = 0 then 'REFUND_REQUIRED' when x.refunded >= k.required_krw then 'REFUNDED' else 'PARTIAL' end as status,
                      (select count(*)::int from public.ordering_refund_requests q
                        where q.tenant_id = k.tenant_id and q.refund_task_id = k.id
                          and not exists (select 1 from public.ordering_refund_request_decisions d where d.tenant_id = q.tenant_id and d.request_id = q.id)) as pending_requests,
                      (select count(*)::int from public.ordering_refund_attempts a
                        where a.tenant_id = k.tenant_id and a.refund_task_id = k.id and a.result = 'UNKNOWN'
                          and not exists (select 1 from public.ordering_refund_attempt_resolutions r where r.tenant_id = a.tenant_id and r.attempt_id = a.id)) as unresolved_attempts
                 from public.ordering_refund_tasks k
                 join public.ordering_orders o on o.tenant_id = k.tenant_id and o.id = k.order_id
                 cross join lateral (select coalesce(sum(c.amount_krw), 0) as refunded from public.ordering_refund_confirmations c where c.tenant_id = k.tenant_id and c.refund_task_id = k.id) x
                where k.tenant_id = $1) s
              where ($2::text is null or s.status = $2)
                and ($3::boolean is not true or s.status <> 'REFUNDED')
                and ($4::text is null or (s.opened_at, s.id) < ($4::timestamptz, $5::uuid))
              order by s.opened_at desc, s.id desc
              limit $6`,
            [request.tenantId, request.status ?? null, request.open === true ? true : null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const items = page.map((r): RefundTaskItem => {
          const required = BigInt(String(r.required_krw));
          const refunded = BigInt(String(r.refunded));
          return {
            id: r.id,
            orderId: r.order_id,
            ...(r.display_number === null ? {} : { orderDisplayNumber: Number(r.display_number) }),
            requiredKrw: required.toString(),
            refundedKrw: refunded.toString(),
            remainingKrw: (required > refunded ? required - refunded : 0n).toString(),
            status: r.status,
            openedAt: (r.opened_at as Date).toISOString(),
            pendingRequests: r.pending_requests,
            unresolvedAttempts: r.unresolved_attempts,
          };
        });
        return { items, ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.opened_at_text, last.id]) } : {}) };
      }),

    /**
     * 수령·결제 현황(O-09): 확정 주문을 최신 접수 순으로, 결제 요약(`paymentSummary`와 같은 규칙: 확인된 거래 − 확인된 환급 − 보정, 무효 제외)과
     * 수령 수량(주문 품목 수량 합, 수령 원장 합 — 정정 역거래 포함, 남은 수량)을 함께 돌려준다. 기본은 종결되지 않은 주문만.
     * `unpaid=true`는 잔액이 남은 주문만, `undelivered=true`는 남은 수량이 있는 주문만, `includeClosed=true`는 종결 주문도 포함한다.
     */
    listOrderSettlements: (actor: Actor, request: ListOrderSettlementsRequest): Promise<{ items: OrderSettlement[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        for (const flag of ["unpaid", "undelivered", "includeClosed"] as const) {
          if (request[flag] !== undefined && typeof request[flag] !== "boolean") throw validation(`${flag} must be a boolean`);
        }
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        if (after && (Number.isNaN(Date.parse(after[0]!)) || !isUuid(after[1]!))) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select * from (
               select o.id, o.display_number, o.created_at, o.created_at::text as created_at_text, coalesce(o.total_krw, 0) as total, x.confirmed, x.pending,
                      (select coalesce(sum(l.quantity), 0)::int from public.ordering_order_lines l where l.tenant_id = o.tenant_id and l.order_id = o.id) as ordered,
                      (select coalesce(sum(f.quantity), 0)::int from public.ordering_fulfillments f where f.tenant_id = o.tenant_id and f.order_id = o.id) as delivered
                 from public.ordering_orders o
                 cross join lateral (
                   select coalesce((select sum(p.amount_krw) from public.ordering_payments p
                                     where p.tenant_id = o.tenant_id and p.order_id = o.id
                                       and exists (select 1 from public.ordering_payment_confirmations c where c.tenant_id = p.tenant_id and c.payment_id = p.id)
                                       and not exists (select 1 from public.ordering_payment_voids v where v.tenant_id = p.tenant_id and v.payment_id = p.id)), 0)
                          - coalesce((select sum(r.amount_krw) from public.ordering_refund_confirmations r where r.tenant_id = o.tenant_id and r.order_id = o.id), 0)
                          - coalesce((select sum(k.reduced_krw) from public.ordering_payment_corrections k where k.tenant_id = o.tenant_id and k.order_id = o.id), 0) as confirmed,
                          coalesce((select sum(p.amount_krw) from public.ordering_payments p
                                     where p.tenant_id = o.tenant_id and p.order_id = o.id
                                       and not exists (select 1 from public.ordering_payment_confirmations c where c.tenant_id = p.tenant_id and c.payment_id = p.id)
                                       and not exists (select 1 from public.ordering_payment_voids v where v.tenant_id = p.tenant_id and v.payment_id = p.id)), 0) as pending
                 ) x
                where o.tenant_id = $1 and o.status = 'CONFIRMED' and ($2::boolean is true or o.closed_at is null)) s
              where ($3::boolean is not true or s.total > s.confirmed)
                and ($4::boolean is not true or s.ordered > s.delivered)
                and ($5::text is null or (s.created_at, s.id) < ($5::timestamptz, $6::uuid))
              order by s.created_at desc, s.id desc
              limit $7`,
            [request.tenantId, request.includeClosed === true ? true : null, request.unpaid === true ? true : null, request.undelivered === true ? true : null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const big = (v: unknown) => BigInt(String(v));
        const items = page.map((r): OrderSettlement => {
          const total = big(r.total);
          const confirmed = big(r.confirmed);
          return {
            orderId: r.id,
            ...(r.display_number === null ? {} : { displayNumber: Number(r.display_number) }),
            totalKrw: total.toString(),
            confirmedKrw: confirmed.toString(),
            pendingKrw: big(r.pending).toString(),
            balanceKrw: (total > confirmed ? total - confirmed : 0n).toString(),
            refundRequiredKrw: (confirmed > total ? confirmed - total : 0n).toString(),
            orderedQuantity: r.ordered,
            deliveredQuantity: r.delivered,
            remainingQuantity: Math.max(r.ordered - r.delivered, 0),
          };
        });
        return { items, ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.created_at_text, last.id]) } : {}) };
      }),

    /**
     * 안내 대기 큐(O-08): 서점의 모든 안내 대상을 최신 생성 순으로. 재안내로 대체된 원 대상은 빼고(새 대상이 이어받는다),
     * 상태는 시도·결과 기록에서 파생한다(`notificationState`와 같은 규칙: 시도 없음 PENDING, 시도만 ATTEMPTED, 마지막 결과가 상태).
     * `status`로 거를 수 있다. 메시지 문구·결과 메모는 싣지 않는다.
     */
    listNotificationQueue: (actor: Actor, request: ListNotificationQueueRequest): Promise<{ items: NotificationQueueItem[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        if (request.status !== undefined && !NOTIFICATION_STATUSES.includes(request.status)) throw validation("invalid status");
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        if (after && (Number.isNaN(Date.parse(after[0]!)) || !isUuid(after[1]!))) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select * from (
               select t.id, t.order_id, o.display_number, t.mode, t.secured_total, t.created_at, t.created_at::text as created_at_text, t.renotice_of_target_id,
                      a.attempted_at, a.channel, r.result_at, r.outcome, cu.id as customer_id, cu.name as customer_name, cu.phone as customer_phone,
                      case when a.id is null then 'PENDING' when r.outcome is null then 'ATTEMPTED' else r.outcome end as status
                 from public.ordering_notification_targets t
                 join public.ordering_orders o on o.tenant_id = t.tenant_id and o.id = t.order_id
                 left join public.ordering_notification_attempts a on a.tenant_id = t.tenant_id and a.target_id = t.id
                 left join lateral (select l.customer_id from public.ordering_order_customer_links l where l.tenant_id = t.tenant_id and l.order_id = t.order_id order by l.recorded_at desc, l.id desc limit 1) lk on true
                 left join public.ordering_customers cu on cu.tenant_id = t.tenant_id and cu.id = lk.customer_id
                 left join lateral (select x.outcome, x.result_at from public.ordering_notification_results x where x.tenant_id = t.tenant_id and x.target_id = t.id order by x.recorded_at desc, x.id desc limit 1) r on true
                where t.tenant_id = $1
                  and not exists (select 1 from public.ordering_notification_targets n where n.tenant_id = t.tenant_id and n.renotice_of_target_id = t.id)) s
              where ($2::text is null or s.status = $2)
                and ($3::text is null or (s.created_at, s.id) < ($3::timestamptz, $4::uuid))
              order by s.created_at desc, s.id desc
              limit $5`,
            [request.tenantId, request.status ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const items = page.map((r): NotificationQueueItem => ({
          id: r.id,
          orderId: r.order_id,
          ...(r.display_number === null ? {} : { orderDisplayNumber: Number(r.display_number) }),
          mode: r.mode,
          securedTotal: r.secured_total,
          status: r.status,
          createdAt: (r.created_at as Date).toISOString(),
          ...(r.renotice_of_target_id === null ? {} : { renoticeOfTargetId: r.renotice_of_target_id }),
          ...(r.attempted_at === null ? {} : { attemptedAt: (r.attempted_at as Date).toISOString(), channel: r.channel }),
          ...(r.outcome === null ? {} : { resultAt: (r.result_at as Date).toISOString(), resultOutcome: r.outcome }),
          ...(r.customer_id === null ? {} : { customer: { id: r.customer_id, name: r.customer_name, phone: r.customer_phone } }),
        }));
        return { items, ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.created_at_text, last.id]) } : {}) };
      }),

    /**
     * 입고 목록(O-07): 최신 입고 순(검수 시각·ID 내림차순) 커서 페이지네이션. 수량은 입고 원장에서 파생한다 —
     * 순정상 = 검수 − 정정, 배분 = 배분 − 해제, 미배분 = 순정상 − 배분(`receiptBalances`의 UNALLOCATED와 같은 규칙).
     * `unallocated=true`면 미배분이 남은 입고만, `purchaseOrderId`면 그 발주의 입고만.
     */
    listReceipts: (actor: Actor, request: ListReceiptsRequest): Promise<{ items: ReceiptSummary[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        if (request.unallocated !== undefined && typeof request.unallocated !== "boolean") throw validation("unallocated must be a boolean");
        if (request.purchaseOrderId !== undefined && !isUuid(request.purchaseOrderId)) throw validation("invalid purchaseOrderId");
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        if (after && (Number.isNaN(Date.parse(after[0]!)) || !isUuid(after[1]!))) throw validation("invalid cursor");
        const rows = (
          await client.query(
            `select * from (${RECEIPT_SUMMARY_SQL} where g.tenant_id = $1 and ($2::uuid is null or g.purchase_order_id = $2::uuid)) s
              where ($3::boolean is not true or s.unallocated_quantity > 0)
                and ($4::text is null or (s.received_at, s.id) < ($4::timestamptz, $5::uuid))
              order by s.received_at desc, s.id desc
              limit $6`,
            [request.tenantId, request.purchaseOrderId ?? null, request.unallocated === true ? true : null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { items: page.map(toReceiptSummary), ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.received_at_text, last.id]) } : {}) };
      }),

    /** 입고 상세(O-07-02): 요약 + 배분(해제 수량 포함)·검수 정정·불량 처리·초과 결정 이력. 증빙 원문은 싣지 않는다 */
    getReceipt: (actor: Actor, request: { tenantId: string; receiptId: string }): Promise<ReceiptDetail> =>
      asMember(actor, request.tenantId, async (client) => {
        const t = request.tenantId;
        const row = isUuid(request.receiptId) ? (await client.query(`${RECEIPT_SUMMARY_SQL} where g.tenant_id = $1 and g.id = $2`, [t, request.receiptId])).rows[0] : undefined;
        if (!row) throw new AppError("NOT_FOUND");
        const iso = (d: Date) => d.toISOString();
        const allocations = (
          await client.query(
            `select a.id, a.order_id, a.order_line_id, a.quantity, a.allocated_by, a.allocated_at,
                    coalesce((select sum(r.quantity) from public.ordering_allocation_releases r where r.tenant_id = a.tenant_id and r.allocation_id = a.id), 0)::int as released
               from public.ordering_receipt_allocations a where a.tenant_id = $1 and a.receipt_id = $2 order by a.allocated_at, a.id`,
            [t, row.id],
          )
        ).rows;
        const corrections = (await client.query("select id, quantity, reason, corrected_by, corrected_at from public.ordering_receipt_corrections where tenant_id = $1 and receipt_id = $2 order by corrected_at, id", [t, row.id])).rows;
        const defects = (await client.query("select id, kind, quantity, outcome, resolved_by, resolved_at from public.ordering_receipt_defect_resolutions where tenant_id = $1 and receipt_id = $2 order by resolved_at, id", [t, row.id])).rows;
        const excess = (await client.query("select id, decision, quantity, reason, decided_by, decided_at from public.ordering_excess_decisions where tenant_id = $1 and receipt_id = $2 order by decided_at, id", [t, row.id])).rows;
        return {
          ...toReceiptSummary(row),
          allocations: allocations.map((a) => ({ id: a.id, orderId: a.order_id, orderLineId: a.order_line_id, quantity: a.quantity, releasedQuantity: a.released, allocatedAt: iso(a.allocated_at), allocatedBy: a.allocated_by })),
          corrections: corrections.map((c) => ({ id: c.id, quantity: c.quantity, reason: c.reason, correctedAt: iso(c.corrected_at), correctedBy: c.corrected_by })),
          defectResolutions: defects.map((d) => ({ id: d.id, kind: d.kind, quantity: d.quantity, outcome: d.outcome, resolvedAt: iso(d.resolved_at), resolvedBy: d.resolved_by })),
          excessDecisions: excess.map((e) => ({ id: e.id, decision: e.decision, quantity: e.quantity, reason: e.reason, decidedAt: iso(e.decided_at), decidedBy: e.decided_by })),
        };
      }),

    /**
     * 대시보드(O-01) 서버 집계: 주문(초안·보류·폐기·확정), 활성 발주(초안·준비·전달·회신), 환급 업무(미환급·일부 환급·남은 금액),
     * 장기 미수령 경고 수. 숫자는 테이블·원장에서 직접 센다. `since`(RFC3339 UTC, 미래 불가)를 주면 그 시각 이후 접수된 주문 수(폐기 제외)도 돌려준다.
     * 장기 미수령 경고는 목록 API와 같은 계산을 별도 트랜잭션으로 한 번 더 실행한다.
     */
    getDashboard: (actor: Actor, request: { tenantId: string; since?: string; thresholdDays?: number; delayDays?: number }): Promise<Dashboard> =>
      asMember(actor, request.tenantId, async (client) => {
        const now = (deps.now ?? (() => new Date()))();
        // 발주 지연 기준일(전달 후 경과일, 기본 7일). 예상 입고일 정책이 없어 전달 시각에서 센다
        const delayDays = request.delayDays ?? 7;
        if (!Number.isInteger(delayDays) || delayDays < 1 || delayDays > 365) throw validation("delayDays must be an integer 1..365");
        if (request.since !== undefined) parseUtcTimestamp("since", request.since, now);
        const t = request.tenantId;
        const orders = (
          await client.query(
            `select count(*) filter (where status = 'DRAFT' and held_at is null and discarded_at is null)::int as draft,
                    count(*) filter (where held_at is not null)::int as held,
                    count(*) filter (where discarded_at is not null)::int as discarded,
                    count(*) filter (where status = 'CONFIRMED')::int as confirmed,
                    count(*) filter (where discarded_at is null and $2::timestamptz is not null and created_at >= $2::timestamptz)::int as received_since
               from public.ordering_orders where tenant_id = $1`,
            [t, request.since ?? null],
          )
        ).rows[0];
        const po = (
          await client.query(
            `select count(*) filter (where status = 'DRAFT')::int as draft, count(*) filter (where status = 'READY')::int as ready,
                    count(*) filter (where status = 'SENT')::int as sent, count(*) filter (where status = 'ACKNOWLEDGED')::int as acknowledged
               from public.ordering_purchase_orders where tenant_id = $1`,
            [t],
          )
        ).rows[0];
        // 환급 업무의 상태·잔량은 환급 확인 합계에서 파생한다(refundTaskState와 같은 규칙: 0이면 미환급, 남으면 일부 환급)
        const refunds = (
          await client.query(
            `select count(*) filter (where refunded = 0)::int as required,
                    count(*) filter (where refunded > 0 and refunded < required_krw)::int as partial,
                    coalesce(sum(greatest(required_krw - refunded, 0)), 0)::text as remaining
               from (select k.required_krw, coalesce((select sum(c.amount_krw) from public.ordering_refund_confirmations c where c.tenant_id = k.tenant_id and c.refund_task_id = k.id), 0) as refunded
                       from public.ordering_refund_tasks k where k.tenant_id = $1) x`,
            [t],
          )
        ).rows[0];
        // 부분입고·미입고 잔량(DASH-003): 전달된(SENT·ACKNOWLEDGED) 발주 품목마다 유효 수량 = 발주 − 품절 회신 − 수락된 취소, 순입고 = 검수 정상 − 정정,
        // 잔량 = max(0, 유효 − 순입고). 입고 가드(007)와 같은 규칙이다. 순입고가 0이면 미입고, 0보다 크면 부분입고
        const procurement = (
          await client.query(
            `select count(*) filter (where remaining > 0 and net_received <= 0)::int as not_received,
                    count(*) filter (where remaining > 0 and net_received > 0)::int as partial,
                    coalesce(sum(remaining) filter (where remaining > 0), 0)::int as quantity,
                    count(*) filter (where remaining > 0 and delivered_at <= $2::timestamptz)::int as delayed,
                    coalesce(sum(remaining) filter (where remaining > 0 and delivered_at <= $2::timestamptz), 0)::int as delayed_quantity
               from (${PO_OPEN_LINE_SQL}) x`,
            [t, new Date(now.getTime() - delayDays * 86_400_000).toISOString()],
          )
        ).rows[0];
        // 취소 후속 처리(DASH-008): 처분이 끝나지 않은(대기·보관·출고가 남은) 취소 물량의 수와 수량 합계. 처분 현황 목록과 같은 파생 규칙이다
        const dispositions = (
          await client.query(
            `select count(*)::int as open_cancellations, coalesce(sum(pending), 0)::int as pending, coalesce(sum(held), 0)::int as held, coalesce(sum(dispatched), 0)::int as dispatched
               from (${ALLOCATION_CANCELLATION_SQL} where c.tenant_id = $1) s
              where s.pending + s.held + s.dispatched > 0`,
            [t],
          )
        ).rows[0];
        // 미결제(DASH-005): 확정 주문별 결제 요약과 같은 규칙 — 확인된 거래(무효 제외) − 확인된 환급 − 보정, 잔액 = max(총액 − 확인 금액, 0)
        const payments = (
          await client.query(
            `select count(*) filter (where total_krw > confirmed)::int as unpaid,
                    coalesce(sum(greatest(total_krw - confirmed, 0)), 0)::text as balance
               from (select o.total_krw,
                            coalesce((select sum(p.amount_krw) from public.ordering_payments p
                                       where p.tenant_id = o.tenant_id and p.order_id = o.id
                                         and exists (select 1 from public.ordering_payment_confirmations c where c.tenant_id = p.tenant_id and c.payment_id = p.id)
                                         and not exists (select 1 from public.ordering_payment_voids v where v.tenant_id = p.tenant_id and v.payment_id = p.id)), 0)
                          - coalesce((select sum(r.amount_krw) from public.ordering_refund_confirmations r where r.tenant_id = o.tenant_id and r.order_id = o.id), 0)
                          - coalesce((select sum(k.reduced_krw) from public.ordering_payment_corrections k where k.tenant_id = o.tenant_id and k.order_id = o.id), 0) as confirmed
                       from public.ordering_orders o where o.tenant_id = $1 and o.status = 'CONFIRMED') x`,
            [t],
          )
        ).rows[0];
        const unconfirmed = (
          await client.query(
            `select count(*)::int as n from public.ordering_payments p
              where p.tenant_id = $1
                and not exists (select 1 from public.ordering_payment_confirmations c where c.tenant_id = p.tenant_id and c.payment_id = p.id)
                and not exists (select 1 from public.ordering_payment_voids v where v.tenant_id = p.tenant_id and v.payment_id = p.id)`,
            [t],
          )
        ).rows[0];
        // 미배분 입고(DASH-008): 입고별 UNALLOCATED 버킷 = (검수 정상 − 검수 정정) − 배분 + 배분 해제 (receiptBalances와 같은 규칙)
        const receipts = (
          await client.query(
            `select count(*) filter (where unallocated > 0)::int as receipts, coalesce(sum(unallocated) filter (where unallocated > 0), 0)::int as quantity
               from (select g.normal_quantity
                            - coalesce((select sum(c.quantity) from public.ordering_receipt_corrections c where c.tenant_id = g.tenant_id and c.receipt_id = g.id), 0)
                            - coalesce((select sum(a.quantity) from public.ordering_receipt_allocations a where a.tenant_id = g.tenant_id and a.receipt_id = g.id), 0)
                            + coalesce((select sum(r.quantity) from public.ordering_allocation_releases r join public.ordering_receipt_allocations a on a.tenant_id = r.tenant_id and a.id = r.allocation_id where a.tenant_id = g.tenant_id and a.receipt_id = g.id), 0) as unallocated
                       from public.ordering_goods_receipts g where g.tenant_id = $1) x`,
            [t],
          )
        ).rows[0];
        // 안내 대상의 상태는 시도·결과 기록에서 파생한다(notificationState와 같은 규칙). 재안내로 대체된 대상과 완료(MANUAL_RECORDED) 대상은 세지 않는다
        const notifications = (
          await client.query(
            `select count(*) filter (where attempts = 0)::int as pending,
                    count(*) filter (where attempts > 0 and last_outcome is null)::int as attempted,
                    count(*) filter (where last_outcome = 'FAILED')::int as failed
               from (select (select count(*) from public.ordering_notification_attempts a where a.tenant_id = t.tenant_id and a.target_id = t.id) as attempts,
                            (select r.outcome from public.ordering_notification_results r where r.tenant_id = t.tenant_id and r.target_id = t.id order by r.recorded_at desc, r.id desc limit 1) as last_outcome
                       from public.ordering_notification_targets t
                      where t.tenant_id = $1
                        and not exists (select 1 from public.ordering_notification_targets n where n.tenant_id = t.tenant_id and n.renotice_of_target_id = t.id)) x`,
            [t],
          )
        ).rows[0];
        const warnings = await api.longUnreceivedWarnings(actor, { tenantId: t, ...(request.thresholdDays !== undefined ? { thresholdDays: request.thresholdDays } : {}) });
        return {
          orders: { draft: orders.draft, held: orders.held, discarded: orders.discarded, confirmed: orders.confirmed },
          purchaseOrders: { draft: po.draft, ready: po.ready, sent: po.sent, acknowledged: po.acknowledged },
          refunds: { required: refunds.required, partial: refunds.partial, remainingKrw: refunds.remaining },
          dispositions: { openCancellations: dispositions.open_cancellations, pendingQuantity: dispositions.pending, heldQuantity: dispositions.held, dispatchedQuantity: dispositions.dispatched },
          procurement: { notReceivedLines: procurement.not_received, partiallyReceivedLines: procurement.partial, remainingQuantity: procurement.quantity, delayedLines: procurement.delayed, delayedQuantity: procurement.delayed_quantity },
          receipts: { unallocatedReceipts: receipts.receipts, unallocatedQuantity: receipts.quantity },
          payments: { unpaidOrders: payments.unpaid, balanceKrw: payments.balance, unconfirmedPayments: unconfirmed.n },
          notifications: { pending: notifications.pending, attempted: notifications.attempted, failed: notifications.failed },
          longUnreceivedWarnings: warnings.length,
          ...(request.since !== undefined ? { receivedSince: orders.received_since } : {}),
        };
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
  return api;
}
