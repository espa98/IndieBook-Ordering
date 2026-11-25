import { verifyJwt, type JwtVerifyOptions } from "../auth/jwt";
import { createPgCancellationApi } from "../db/pgCancellationApi";
import { createPgDispositionApi } from "../db/pgDispositionApi";
import { createPgFulfillmentApi } from "../db/pgFulfillmentApi";
import { createPgNotificationApi } from "../db/pgNotificationApi";
import { createPgReadApi } from "../db/pgReadApi";
import { createPgOrderApi } from "../db/pgOrderApi";
import { createPgPaymentApi } from "../db/pgPaymentApi";
import { createPgProcurementApi } from "../db/pgProcurementApi";
import { createPgReceivingApi } from "../db/pgReceivingApi";
import { assertWithinLimits } from "./inputLimits";
import { createPgAccountApi } from "../db/pgAccountApi";
import { createPgCatalogApi } from "../db/pgCatalogApi";
import { createPgStaffApi } from "../db/pgStaffApi";
import { createPgStockApi } from "../db/pgStockApi";
import { createPgSupplierApi } from "../db/pgSupplierApi";
import type { PoolLike } from "../db/pgSupport";
import { AppError } from "../errors/AppError";
import { toErrorResponse } from "./toErrorResponse";

/** 서버 래퍼가 읽어 넘기는 요청. 본문은 JSON으로 파싱하기 전의 문자열이다 */
export type AppRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  /** 소문자 이름 */
  headers: Record<string, string | undefined>;
  rawBody: string | undefined;
};
export type AppResponse = { status: number; body: unknown; headers?: Record<string, string> };

export type AppDeps = {
  pool: PoolLike;
  jwt: JwtVerifyOptions;
  /** 처리하지 못한 오류의 원본을 받는다(서버측 로깅 자리). 응답에는 쓰이지 않는다 */
  logError?: (error: unknown) => void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

type Ctx = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  userId: string;
  /** 인증 제공자가 토큰에 담은 최상위 `email` claim. `user_metadata`는 사용자가 고칠 수 있어 쓰지 않는다 */
  email: string | undefined;
  idempotencyKey: string;
};
type Route = {
  method: "GET" | "POST";
  pattern: RegExp;
  /** OpenAPI 표기의 경로(`/orders/{orderId}`). 명세와의 드리프트 검사에 쓴다 */
  template: string;
  /** 허용하는 본문 필드. 없으면 본문을 받지 않는다 */
  fields?: readonly string[];
  /** 허용하는 쿼리 파라미터 */
  queryFields?: readonly string[];
  success: number;
  /** `account`: 서점에 속하기 전의 계정 업무(`/v1/...`). 기본은 서점 범위(`/v1/tenants/{tenantId}/...`) */
  scope: "tenant" | "account";
  run: (ctx: Ctx) => Promise<unknown>;
};

const T = "/v1/tenants/(?<tenantId>[^/]+)";
const route = (method: Route["method"], path: string, spec: Omit<Route, "method" | "pattern" | "template" | "scope">): Route => ({
  method,
  pattern: new RegExp(`^${T}${path}$`),
  template: path.replace(/\(\?<(\w+)>[^)]*\)/g, "{$1}"),
  scope: "tenant",
  ...spec,
});
const accountRoute = (method: Route["method"], path: string, spec: Omit<Route, "method" | "pattern" | "template" | "scope">): Route => ({
  method,
  pattern: new RegExp(`^/v1${path}$`),
  template: path,
  scope: "account",
  ...spec,
});

const validation = (message: string) => new AppError("VALIDATION_ERROR", message);

/** 서버가 제공하는 경로의 공개 정보(명세 대조용) */
export type RouteInfo = { method: "GET" | "POST"; scope: "tenant" | "account"; template: string; fields?: readonly string[]; queryFields?: readonly string[]; success: number };

export function createApp(deps: AppDeps): ((request: AppRequest) => Promise<AppResponse>) & { routes: RouteInfo[] } {
  const orders = createPgOrderApi({ pool: deps.pool });
  const stock = createPgStockApi({ pool: deps.pool });
  const payments = createPgPaymentApi({ pool: deps.pool });
  const fulfillments = createPgFulfillmentApi({ pool: deps.pool });
  const receiving = createPgReceivingApi({ pool: deps.pool });
  const procurement = createPgProcurementApi({ pool: deps.pool });
  const suppliers = createPgSupplierApi({ pool: deps.pool });
  const staffAdmin = createPgStaffApi({ pool: deps.pool });
  const accounts = createPgAccountApi({ pool: deps.pool });
  const catalog = createPgCatalogApi({ pool: deps.pool });
  const notifications = createPgNotificationApi({ pool: deps.pool });
  const reads = createPgReadApi({ pool: deps.pool });
  const cancellations = createPgCancellationApi({ pool: deps.pool });
  const dispositions = createPgDispositionApi({ pool: deps.pool });
  const actor = (c: Ctx) => ({ userId: c.userId });
  // 본문은 신뢰할 수 없는 JSON이다. 형식 검증은 도메인이 하므로 여기서는 경계 타입만 맞춘다
  const merge = (c: Ctx, extra: Record<string, unknown>) => ({ ...c.body, ...extra }) as never;
  const t = (c: Ctx) => c.params.tenantId!;
  const text = (c: Ctx, name: string) => (c.query.has(name) ? { [name]: c.query.get(name) as string } : {});
  const int = (c: Ctx, name: string) => (c.query.has(name) ? { [name]: Number(c.query.get(name)) } : {});

  const routes: Route[] = [
    route("GET", "/orders", {
      success: 200,
      queryFields: ["limit", "cursor", "status"],
      run: (c) =>
        orders.listOrders(actor(c), {
          tenantId: t(c),
          ...(c.query.has("limit") ? { limit: Number(c.query.get("limit")) } : {}),
          ...(c.query.has("cursor") ? { cursor: c.query.get("cursor") as string } : {}),
          ...(c.query.has("status") ? { status: c.query.get("status") as never } : {}),
        }),
    }),
    route("POST", "/orders", {
      success: 201,
      fields: ["lines"],
      run: (c) => orders.createOrder(actor(c), { tenantId: t(c), idempotencyKey: c.idempotencyKey, lines: c.body.lines as never }),
    }),
    route("GET", "/orders/(?<orderId>[^/]+)", {
      success: 200,
      run: (c) => orders.getOrder(actor(c), { tenantId: t(c), orderId: c.params.orderId! }),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/confirm", {
      success: 200,
      fields: ["expectedVersion"],
      run: (c) =>
        orders.confirmOrder(actor(c), { tenantId: t(c), orderId: c.params.orderId!, expectedVersion: c.body.expectedVersion as never, idempotencyKey: c.idempotencyKey }),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/lines/(?<lineId>[^/]+)/stock-reservations", {
      success: 201,
      fields: ["quantity", "reservedAt"],
      run: (c) =>
        stock.reserveStock(actor(c), {
          tenantId: t(c),
          orderId: c.params.orderId!,
          orderLineId: c.params.lineId!,
          quantity: c.body.quantity as never,
          reservedAt: c.body.reservedAt as never,
          idempotencyKey: c.idempotencyKey,
        }),
    }),
    route("POST", "/books/(?<bookId>[^/]+)/initial-stock", {
      success: 201,
      fields: ["quantity", "actedAt"],
      run: (c) => stock.registerInitialStock(actor(c), merge(c, { tenantId: t(c), bookId: c.params.bookId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/books/(?<bookId>[^/]+)/stock-adjustments", {
      success: 201,
      fields: ["direction", "quantity", "reason", "actedAt"],
      run: (c) => stock.adjustStock(actor(c), merge(c, { tenantId: t(c), bookId: c.params.bookId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/stock-reservations/(?<reservationId>[^/]+)/releases", {
      success: 201,
      fields: ["quantity", "reason", "releasedAt"],
      run: (c) => stock.releaseStockReservation(actor(c), merge(c, { tenantId: t(c), reservationId: c.params.reservationId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/payments/(?<paymentId>[^/]+)/void", {
      success: 201,
      fields: ["reason", "voidedAt"],
      run: (c) => payments.voidPayment(actor(c), merge(c, { tenantId: t(c), paymentId: c.params.paymentId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/fulfillments", {
      success: 201,
      fields: ["orderLineId", "sources", "receivedAt"],
      run: (c) => fulfillments.postFulfillment(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/fulfillments/(?<fulfillmentId>[^/]+)/corrections", {
      success: 201,
      fields: ["quantity", "restorations", "reason", "evidence", "physicalReturnConfirmed", "correctedAt"],
      run: (c) => fulfillments.correctFulfillment(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, fulfillmentId: c.params.fulfillmentId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/payments/(?<paymentId>[^/]+)/corrections", {
      success: 201,
      fields: ["reducedKrw", "reason", "evidence", "correctedAt"],
      run: (c) => payments.correctPayment(actor(c), merge(c, { tenantId: t(c), paymentId: c.params.paymentId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/cancellation-requests", {
      success: 201,
      fields: ["orderLineId", "quantity", "reason", "expectedVersion", "requestedAt"],
      run: (c) => fulfillments.requestOrderCancellation(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/order-cancellation-requests/(?<requestId>[^/]+)/decision", {
      success: 200,
      fields: ["decision", "decidedAt"],
      run: (c) => cancellations.decideOrderCancellation(actor(c), merge(c, { tenantId: t(c), requestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/order-cancellation-requests/(?<requestId>[^/]+)/application", {
      success: 201,
      fields: ["appliedAt"],
      run: (c) => cancellations.applyOrderCancellation(actor(c), merge(c, { tenantId: t(c), requestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/closure-requests", {
      success: 201,
      fields: ["expectedVersion", "requestedAt"],
      run: (c) => cancellations.requestOrderClosure(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/allocation-cancellations/(?<cancellationId>[^/]+)/stock-intakes", {
      success: 201,
      fields: ["quantity", "actedAt"],
      run: (c) => dispositions.transferCancelledToStock(actor(c), merge(c, { tenantId: t(c), cancellationId: c.params.cancellationId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/allocation-cancellations/(?<cancellationId>[^/]+)/return-requests", {
      success: 201,
      fields: ["quantity", "requestedAt"],
      run: (c) => dispositions.requestReturn(actor(c), merge(c, { tenantId: t(c), cancellationId: c.params.cancellationId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/return-requests/(?<requestId>[^/]+)/replies", {
      success: 201,
      fields: ["acceptedQuantity", "rejectedQuantity", "evidence", "repliedAt"],
      run: (c) => dispositions.recordReturnReply(actor(c), merge(c, { tenantId: t(c), returnRequestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/return-requests/(?<requestId>[^/]+)/dispatches", {
      success: 201,
      fields: ["quantity", "dispatchedAt", "referenceNumber"],
      run: (c) => dispositions.dispatchReturn(actor(c), merge(c, { tenantId: t(c), returnRequestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/return-requests/(?<requestId>[^/]+)/completions", {
      success: 201,
      fields: ["quantity", "evidence", "confirmedAt"],
      run: (c) => dispositions.completeReturn(actor(c), merge(c, { tenantId: t(c), returnRequestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/return-requests/(?<requestId>[^/]+)/exceptions", {
      success: 201,
      fields: ["quantity", "kind", "evidence", "reportedAt"],
      run: (c) => dispositions.reportReturnException(actor(c), merge(c, { tenantId: t(c), returnRequestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/return-requests/(?<requestId>[^/]+)/renegotiations", {
      success: 201,
      fields: ["quantity", "retryReason", "requestedAt"],
      run: (c) => dispositions.renegotiateReturn(actor(c), merge(c, { tenantId: t(c), originalRequestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/return-exceptions/(?<exceptionId>[^/]+)/resolutions", {
      success: 201,
      fields: ["outcome", "quantity", "evidence", "resolvedAt"],
      run: (c) => dispositions.resolveReturnException(actor(c), merge(c, { tenantId: t(c), returnExceptionId: c.params.exceptionId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/payments", {
      success: 201,
      fields: ["method", "amountKrw", "externalReference", "paidAt"],
      run: (c) => payments.recordPayment(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/payments/(?<paymentId>[^/]+)/confirmation", {
      success: 201,
      fields: ["evidence", "confirmedAt"],
      run: (c) => payments.confirmPayment(actor(c), merge(c, { tenantId: t(c), paymentId: c.params.paymentId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/refund-tasks", {
      success: 201,
      fields: ["openedAt"],
      run: (c) => payments.openRefundTask(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/refund-tasks/(?<taskId>[^/]+)/refund-requests", {
      success: 201,
      fields: ["paymentId", "amountKrw", "evidence", "requestedAt"],
      run: (c) => payments.requestRefund(actor(c), merge(c, { tenantId: t(c), refundTaskId: c.params.taskId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/refund-tasks/(?<taskId>[^/]+)/refund-attempts", {
      success: 201,
      fields: ["paymentId", "amountKrw", "result", "reason", "reportedAt"],
      run: (c) => payments.reportRefundAttempt(actor(c), merge(c, { tenantId: t(c), refundTaskId: c.params.taskId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/refund-attempts/(?<attemptId>[^/]+)/resolution", {
      success: 201,
      fields: ["outcome", "evidence", "resolvedAt"],
      run: (c) => payments.resolveRefundAttempt(actor(c), merge(c, { tenantId: t(c), attemptId: c.params.attemptId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/message-templates", {
      success: 201,
      fields: ["key", "body", "expectedVersion", "publishedAt"],
      run: (c) => catalog.publishTemplateVersion(actor(c), merge(c, { tenantId: t(c), idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/notification-targets", {
      success: 201,
      fields: ["mode", "createdAt"],
      run: (c) => notifications.createNotificationTarget(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/notification-targets/(?<targetId>[^/]+)/copies", {
      success: 201,
      fields: ["action", "actedAt"],
      run: (c) => notifications.recordNotificationCopy(actor(c), merge(c, { tenantId: t(c), targetId: c.params.targetId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/notification-targets/(?<targetId>[^/]+)/attempts", {
      success: 201,
      fields: ["channel", "messageSnapshot", "attemptedAt"],
      run: (c) => notifications.recordNotificationAttempt(actor(c), merge(c, { tenantId: t(c), targetId: c.params.targetId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/notification-targets/(?<targetId>[^/]+)/renotices", {
      success: 201,
      fields: ["createdAt"],
      run: (c) => notifications.renotify(actor(c), merge(c, { tenantId: t(c), targetId: c.params.targetId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/notification-attempts/(?<attemptId>[^/]+)/result", {
      success: 201,
      fields: ["outcome", "note", "resultAt"],
      run: (c) => notifications.recordNotificationResult(actor(c), merge(c, { tenantId: t(c), attemptId: c.params.attemptId!, idempotencyKey: c.idempotencyKey })),
    }),
    accountRoute("POST", "/stores", {
      success: 201,
      fields: ["storeName"],
      // 개설 권한: 이메일 claim이 있는 로그인 계정 누구나(ST-A02). 소유자는 항상 인증된 사용자이고 본문으로 정할 수 없다
      run: (c) => {
        if (typeof c.email !== "string" || c.email === "") throw new AppError("FORBIDDEN");
        return accounts.openStore({ userId: c.userId, email: c.email }, { storeName: c.body.storeName as never, idempotencyKey: c.idempotencyKey });
      },
    }),
    accountRoute("POST", "/invitations/accept", {
      success: 201,
      fields: ["token"],
      // 이메일은 본문이 아니라 검증된 토큰에서만 가져온다. 이메일 claim이 없으면 초대와 대조할 수 없으므로 거부한다
      run: (c) => {
        if (typeof c.email !== "string" || c.email === "") throw new AppError("FORBIDDEN");
        return staffAdmin.acceptInvitation({ userId: c.userId, email: c.email }, { token: c.body.token as never, idempotencyKey: c.idempotencyKey });
      },
    }),
    route("GET", "/suppliers", {
      success: 200,
      run: (c) => reads.listSuppliers(actor(c), { tenantId: t(c) }),
    }),
    route("GET", "/suppliers/(?<code>[a-z0-9][a-z0-9-]{0,31})", {
      success: 200,
      run: (c) => reads.getSupplier(actor(c), { tenantId: t(c), code: c.params.code! }),
    }),
    route("GET", "/purchase-orders", {
      success: 200,
      queryFields: ["limit", "cursor", "status", "supplierCode"],
      run: (c) => reads.listPurchaseOrders(actor(c), { tenantId: t(c), ...int(c, "limit"), ...text(c, "cursor"), ...text(c, "status"), ...text(c, "supplierCode") }),
    }),
    route("GET", "/purchase-orders/(?<purchaseOrderId>[^/]+)", {
      success: 200,
      run: (c) => reads.getPurchaseOrder(actor(c), { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId! }),
    }),
    route("GET", "/stock", {
      success: 200,
      queryFields: ["limit", "cursor"],
      run: (c) => reads.listStockLevels(actor(c), { tenantId: t(c), ...int(c, "limit"), ...text(c, "cursor") }),
    }),
    route("GET", "/stock/(?<bookId>[^/]+)", {
      success: 200,
      run: (c) => reads.getStockLevel(actor(c), { tenantId: t(c), bookId: c.params.bookId! }),
    }),
    route("GET", "/orders/(?<orderId>[^/]+)/payments", {
      success: 200,
      run: (c) => reads.getOrderPayments(actor(c), { tenantId: t(c), orderId: c.params.orderId! }),
    }),
    route("GET", "/books", {
      success: 200,
      queryFields: ["limit", "cursor", "isbn"],
      run: (c) => reads.listBooks(actor(c), { tenantId: t(c), ...int(c, "limit"), ...text(c, "cursor"), ...text(c, "isbn") }),
    }),
    route("GET", "/books/(?<bookId>[^/]+)", {
      success: 200,
      run: (c) => reads.getBook(actor(c), { tenantId: t(c), bookId: c.params.bookId! }),
    }),
    route("GET", "/books/(?<bookId>[^/]+)/revisions", {
      success: 200,
      run: (c) => reads.listBookRevisions(actor(c), { tenantId: t(c), bookId: c.params.bookId! }),
    }),
    route("GET", "/message-templates", {
      success: 200,
      queryFields: ["key"],
      run: (c) => reads.listMessageTemplates(actor(c), { tenantId: t(c), ...text(c, "key") }),
    }),
    route("GET", "/orders/(?<orderId>[^/]+)/notification-targets", {
      success: 200,
      run: (c) => reads.listNotificationTargets(actor(c), { tenantId: t(c), orderId: c.params.orderId! }),
    }),
    route("GET", "/long-unreceived-warnings", {
      success: 200,
      queryFields: ["thresholdDays"],
      run: (c) => reads.longUnreceivedWarnings(actor(c), { tenantId: t(c), ...int(c, "thresholdDays") }),
    }),
    route("POST", "/books", {
      success: 201,
      fields: ["source", "title", "authors", "isbn", "listPriceKrw", "externalId", "fetchedAt", "reason", "acknowledgeDuplicateOf", "registeredAt"],
      run: (c) => catalog.registerBook(actor(c), merge(c, { tenantId: t(c), idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/books/(?<bookId>[^/]+)/updates", {
      success: 200,
      fields: ["expectedVersion", "changes", "reason", "acknowledgeDuplicateOf", "changedAt"],
      run: (c) => catalog.updateBook(actor(c), merge(c, { tenantId: t(c), bookId: c.params.bookId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/staff-invitations", {
      success: 201,
      fields: ["email", "expiresAt"],
      run: (c) => staffAdmin.inviteStaff(actor(c), merge(c, { tenantId: t(c), idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/staff-invitations/(?<invitationId>[^/]+)/revocation", {
      success: 201,
      run: (c) => staffAdmin.revokeInvitation(actor(c), { tenantId: t(c), invitationId: c.params.invitationId!, idempotencyKey: c.idempotencyKey }),
    }),
    route("POST", "/members/(?<targetUserId>[^/]+)/status", {
      success: 200,
      fields: ["status"],
      run: (c) => staffAdmin.setMembershipStatus(actor(c), merge(c, { tenantId: t(c), targetUserId: c.params.targetUserId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/suppliers", {
      success: 201,
      fields: ["code", "name", "orderChannel", "registeredAt"],
      run: (c) => suppliers.registerSupplier(actor(c), merge(c, { tenantId: t(c), idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/suppliers/(?<code>[a-z0-9][a-z0-9-]{0,31})/updates", {
      success: 200,
      fields: ["expectedVersion", "changes", "reason", "changedAt"],
      run: (c) => suppliers.updateSupplier(actor(c), merge(c, { tenantId: t(c), code: c.params.code!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/suppliers/(?<code>[a-z0-9][a-z0-9-]{0,31})/activation", {
      success: 200,
      fields: ["active", "reason", "changedAt"],
      run: (c) => suppliers.setSupplierActive(actor(c), merge(c, { tenantId: t(c), code: c.params.code!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/lines/(?<lineId>[^/]+)/sourcing-allocations", {
      success: 201,
      fields: ["supplierCode", "quantity"],
      run: (c) => procurement.allocateSourcing(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, lineId: c.params.lineId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/orders/(?<orderId>[^/]+)/lines/(?<lineId>[^/]+)/duplicate-risk-approvals", {
      success: 201,
      fields: ["purchaseOrderId", "poLineId", "surplusPlan", "planNote", "approvedAt"],
      run: (c) => procurement.approveDuplicateRisk(actor(c), merge(c, { tenantId: t(c), orderId: c.params.orderId!, lineId: c.params.lineId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/sourcing-allocations/(?<allocationId>[^/]+)/releases", {
      success: 201,
      fields: ["reason", "releasedAt"],
      run: (c) => procurement.releaseSourcing(actor(c), merge(c, { tenantId: t(c), allocationId: c.params.allocationId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders", {
      success: 201,
      fields: ["supplierCode", "allocationIds"],
      run: (c) => procurement.createPurchaseOrder(actor(c), merge(c, { tenantId: t(c), idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/ready", {
      success: 200,
      fields: ["expectedVersion"],
      run: (c) => procurement.markPurchaseOrderReady(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/delivery", {
      success: 200,
      fields: ["expectedVersion", "method", "deliveredAt", "referenceNumber", "fileVersion"],
      run: (c) => procurement.recordPurchaseOrderDelivery(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/cancellation", {
      success: 200,
      fields: ["expectedVersion", "reason", "cancelledAt"],
      run: (c) => procurement.cancelUndeliveredPurchaseOrder(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/lines/(?<poLineId>[^/]+)/cancellation-requests", {
      success: 201,
      fields: ["quantity", "reason"],
      run: (c) => procurement.createCancellationRequest(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, poLineId: c.params.poLineId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/cancellation-requests/(?<requestId>[^/]+)/responses", {
      success: 201,
      fields: ["acceptedQuantity", "rejectedQuantity", "evidence", "repliedAt"],
      run: (c) => procurement.respondToCancellationRequest(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, cancellationRequestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/cancellation-confirmation", {
      success: 200,
      fields: ["expectedVersion"],
      run: (c) => procurement.confirmPurchaseOrderCancellation(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/supplier-replies", {
      success: 201,
      fields: ["poLineId", "kind", "quantity", "source", "eta", "evidence", "repliedAt"],
      run: (c) => procurement.recordSupplierReply(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/purchase-orders/(?<purchaseOrderId>[^/]+)/receipts", {
      success: 201,
      fields: ["poLineId", "normalQuantity", "damagedQuantity", "misdeliveredQuantity", "receivedAt"],
      run: (c) => receiving.receiveGoods(actor(c), merge(c, { tenantId: t(c), purchaseOrderId: c.params.purchaseOrderId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/receipts/(?<receiptId>[^/]+)/defect-resolutions", {
      success: 201,
      fields: ["kind", "quantity", "outcome", "evidence", "resolvedAt"],
      run: (c) => receiving.resolveReceiptDefect(actor(c), merge(c, { tenantId: t(c), receiptId: c.params.receiptId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/receipts/(?<receiptId>[^/]+)/excess-decisions", {
      success: 201,
      fields: ["decision", "quantity", "reason", "decidedAt"],
      run: (c) => receiving.decideExcessReceipt(actor(c), merge(c, { tenantId: t(c), receiptId: c.params.receiptId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/receipts/(?<receiptId>[^/]+)/corrections", {
      success: 201,
      fields: ["quantity", "reason", "correctedAt"],
      run: (c) => receiving.correctReceipt(actor(c), merge(c, { tenantId: t(c), receiptId: c.params.receiptId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/receipts/(?<receiptId>[^/]+)/allocations", {
      success: 201,
      fields: ["orderId", "orderLineId", "quantity", "allocatedAt"],
      run: (c) => receiving.allocateReceipt(actor(c), merge(c, { tenantId: t(c), receiptId: c.params.receiptId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/allocations/(?<allocationId>[^/]+)/cancellations", {
      success: 201,
      fields: ["quantity", "reason", "cancelledAt"],
      run: (c) => receiving.cancelAllocation(actor(c), merge(c, { tenantId: t(c), allocationId: c.params.allocationId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/allocations/(?<allocationId>[^/]+)/reallocations", {
      success: 201,
      fields: ["toOrderId", "toOrderLineId", "quantity", "reason", "actedAt"],
      run: (c) => receiving.reallocateAllocation(actor(c), merge(c, { tenantId: t(c), allocationId: c.params.allocationId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/allocations/(?<allocationId>[^/]+)/releases", {
      success: 201,
      fields: ["quantity", "reason", "releasedAt"],
      run: (c) => receiving.releaseAllocation(actor(c), merge(c, { tenantId: t(c), allocationId: c.params.allocationId!, idempotencyKey: c.idempotencyKey })),
    }),
    route("POST", "/refund-requests/(?<requestId>[^/]+)/decision", {
      success: 200,
      fields: ["decision", "decidedAt"],
      run: (c) => payments.decideRefundRequest(actor(c), merge(c, { tenantId: t(c), requestId: c.params.requestId!, idempotencyKey: c.idempotencyKey })),
    }),
  ];

  function authenticate(request: AppRequest): { userId: string; email: string | undefined } {
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "");
    if (!match) throw new AppError("UNAUTHENTICATED");
    const claims = verifyJwt(match[1]!, deps.jwt);
    return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined };
  }

  function parseBody(request: AppRequest, fields: readonly string[]): Record<string, unknown> {
    const contentType = request.headers["content-type"] ?? "";
    if (request.rawBody === undefined || request.rawBody === "") throw validation("Request body is required");
    if (!/^application\/json(\s*;|$)/i.test(contentType)) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.rawBody);
    } catch {
      throw validation("Request body must be valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("Request body must be a JSON object");
    // 허용 목록에 없는 필드는 거부한다. 클라이언트가 보낸 필드 이름은 되돌리지 않는다
    if (Object.keys(parsed).some((key) => !fields.includes(key))) {
      throw validation(`Request contains fields that are not allowed (allowed: ${fields.join(", ")})`);
    }
    assertWithinLimits(parsed);
    return parsed as Record<string, unknown>;
  }

  const handler = async (request: AppRequest): Promise<AppResponse> => {
    try {
      if (request.path === "/healthz") {
        if (request.method !== "GET") return { status: 405, body: errorBody("METHOD_NOT_ALLOWED", "Method not allowed"), headers: { allow: "GET" } };
        return { status: 200, body: { status: "ok" } };
      }
      if (!request.path.startsWith("/v1/")) throw new AppError("NOT_FOUND");

      // 인증이 가장 먼저다. 존재하는 경로와 없는 경로가 같은 401을 낸다
      const { userId, email } = authenticate(request);

      const matches = routes.flatMap((r) => {
        const m = r.pattern.exec(request.path);
        return m ? [{ r, params: { ...m.groups } as Record<string, string> }] : [];
      });
      if (matches.length === 0) throw new AppError("NOT_FOUND");
      const hit = matches.find((m) => m.r.method === request.method);
      if (!hit) {
        const allow = [...new Set(matches.map((m) => m.r.method))].join(", ");
        return { status: 405, body: errorBody("METHOD_NOT_ALLOWED", "Method not allowed"), headers: { allow } };
      }
      // 경로 식별자는 UUID여야 한다. 공급처 코드(`code`)만 예외이며 라우트 패턴이 코드 형식으로 제한한다
      if (Object.entries(hit.params).some(([name, v]) => name !== "code" && !UUID.test(v))) throw new AppError("NOT_FOUND");

      const query = request.query;
      if ([...query.keys()].some((k) => !(hit.r.queryFields ?? []).includes(k))) {
        throw validation("Request contains query parameters that are not allowed");
      }
      let idempotencyKey = "";
      let body: Record<string, unknown> = {};
      if (hit.r.method === "POST") {
        idempotencyKey = (request.headers["idempotency-key"] ?? "").trim();
        if (idempotencyKey === "" || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
          throw validation(`Idempotency-Key header is required (1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters)`);
        }
        body = parseBody(request, hit.r.fields ?? []);
      }
      const data = await hit.r.run({ params: hit.params, query, body, userId, email, idempotencyKey });
      return { status: hit.r.success, body: { data } };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, body: errorBody(error.code, error.message) };
      if (!(error instanceof AppError)) {
        try {
          deps.logError?.(error);
        } catch {
          // 로깅 실패가 응답을 깨뜨리면 안 된다
        }
      }
      const response = toErrorResponse(error);
      return { status: response.status, body: response.body };
    }
  };
  const info: RouteInfo[] = routes.map(({ method, scope, template, fields, queryFields, success }) => ({ method, scope, template, ...(fields ? { fields } : {}), ...(queryFields ? { queryFields } : {}), success }));
  return Object.assign(handler, { routes: info });
}

/** AppError에 없는 HTTP 전용 오류(415 등) */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorBody = (code: string, message: string) => ({ error: { code, message } });
