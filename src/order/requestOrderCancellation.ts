import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { FulfillmentRepository } from "../fulfillment/postFulfillment";
import type { OrderRepository } from "./confirmOrderService";
import { assertOrderOpenForTransactions } from "./orderGuards";
import { activeCancellationLock } from "./orderCancellationState";

/** 주문 취소 요청 (추가 전용, BR-O05). 요청은 주문 수량을 바꾸지 않는다 — 적용이 바꾼다. */
export type OrderCancellationRequest = {
  id: string;
  tenantId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  reason: string;
  /** 요청 시점의 주문 version. 승인·적용 시 다르면 STALE이다 (BR-O05) */
  baseVersion: number;
  requestedBy: string;
  requestedAt: string;
  recordedAt: string;
};

export type OrderCancellationDecisionKind =
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "STALE"
  | "APPLIED";

/** 요청에 대한 결정·상태 전이 기록 (추가 전용). 요청 상태는 이 기록에서 파생한다. */
export type OrderCancellationDecision = {
  id: string;
  tenantId: string;
  requestId: string;
  kind: OrderCancellationDecisionKind;
  decidedBy: string;
  decidedAt: string;
  note?: string;
  recordedAt: string;
};

export type OrderCancellationRequestRepository = {
  get(tenantId: string, id: string): OrderCancellationRequest | undefined;
  list(tenantId: string, orderId: string): OrderCancellationRequest[];
  save(request: OrderCancellationRequest): void;
};

export type OrderCancellationDecisionRepository = {
  list(tenantId: string, requestId: string): OrderCancellationDecision[];
  save(decision: OrderCancellationDecision): void;
};

export type RequestOrderCancellationDeps = {
  orders: OrderRepository;
  orderCancellationRequests: OrderCancellationRequestRepository;
  orderCancellationDecisions: Pick<OrderCancellationDecisionRepository, "list">;
  fulfillments: Pick<FulfillmentRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RequestOrderCancellationRequest = {
  tenantId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  reason: string;
  expectedVersion: number;
  requestedBy: string;
  requestedAt: string;
  idempotencyKey: string;
};

export function requestOrderCancellation(
  deps: RequestOrderCancellationDeps,
  request: RequestOrderCancellationRequest,
): OrderCancellationRequest {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["reason", "requestedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    invalid("expectedVersion", "must be an integer >= 1");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("requestedAt", request.requestedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "order.request-cancellation",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        orderLineId: request.orderLineId,
        quantity: request.quantity,
        reason: request.reason,
        expectedVersion: request.expectedVersion,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) {
        throw new AppError("NOT_FOUND");
      }
      const line = order.lines.find((l) => l.lineId === request.orderLineId);
      if (!line) {
        throw new AppError("NOT_FOUND");
      }
      assertOrderOpenForTransactions(order, "requesting a cancellation");
      // 요청은 확인한 주문 version 기준이어야 한다 (BR-O05)
      if (order.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      // 취소 가능량 = E - F - 진행 중인 요청의 잠금. 이미 인도한 물량은 일반 취소 대상이 아니다 (BR-O06, D27)
      const received = deps.fulfillments
        .list(request.tenantId, order.id)
        .filter((f) => f.orderLineId === line.lineId)
        .reduce((sum, f) => sum + f.quantity, 0);
      const locked = activeCancellationLock(
        deps.orderCancellationRequests.list(request.tenantId, order.id),
        (requestId) => deps.orderCancellationDecisions.list(request.tenantId, requestId),
        line.lineId,
      );
      if (request.quantity > line.quantity - received - locked) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "cancellation quantity must not exceed the undelivered, unlocked quantity",
        );
      }
      const cancellation: OrderCancellationRequest = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: order.id,
        orderLineId: request.orderLineId,
        quantity: request.quantity,
        reason: request.reason,
        baseVersion: request.expectedVersion,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        recordedAt: now.toISOString(),
      };
      deps.orderCancellationRequests.save(cancellation);
      return cancellation;
    },
  );
}
