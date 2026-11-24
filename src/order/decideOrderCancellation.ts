import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { orderCancellationStatus } from "./orderCancellationState";
import type { OrderRepository } from "./confirmOrderService";
import type {
  OrderCancellationDecision,
  OrderCancellationDecisionRepository,
  OrderCancellationRequestRepository,
} from "./requestOrderCancellation";

export type DecideOrderCancellationDeps = {
  orders: OrderRepository;
  orderCancellationRequests: OrderCancellationRequestRepository;
  orderCancellationDecisions: OrderCancellationDecisionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type DecideOrderCancellationRequest = {
  tenantId: string;
  requestId: string;
  decision: "APPROVED" | "REJECTED" | "WITHDRAWN";
  actorRole: "OWNER" | "STAFF";
  decidedBy: string;
  decidedAt: string;
  note?: string;
  idempotencyKey: string;
};

/**
 * 취소 요청의 승인·거절·철회를 기록한다 (BR-O05). 승인 자체는 수량을 바꾸지 않고,
 * 적용(applyOrderCancellation)이 주문 수량을 줄인다.
 */
export function decideOrderCancellation(
  deps: DecideOrderCancellationDeps,
  request: DecideOrderCancellationRequest,
): OrderCancellationDecision {
  if (
    request.decision !== "APPROVED" &&
    request.decision !== "REJECTED" &&
    request.decision !== "WITHDRAWN"
  ) {
    invalid("decision", "must be APPROVED, REJECTED or WITHDRAWN");
  }
  if (!isNonEmptyString(request.decidedBy)) {
    invalid("decidedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("decidedAt", request.decidedAt, now);
  // 승인·거절은 Owner 업무다(DEC-09). 철회는 Staff도 할 수 있다
  if (request.decision !== "WITHDRAWN" && request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "order.decide-cancellation",
      key: request.idempotencyKey,
      payload: {
        requestId: request.requestId,
        decision: request.decision,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt,
        note: request.note ?? null,
      },
    },
    () => {
      const cancellation = deps.orderCancellationRequests.get(request.tenantId, request.requestId);
      if (!cancellation) {
        throw new AppError("NOT_FOUND");
      }
      // 결정은 REQUESTED 상태에서만 할 수 있다 (BR-O05)
      const existing = deps.orderCancellationDecisions.list(request.tenantId, cancellation.id);
      if (orderCancellationStatus(existing) !== "REQUESTED") {
        throw new AppError("BUSINESS_INVARIANT", "the cancellation request is already decided");
      }
      // 승인 시점에 대상 주문 version이 달라졌으면 승인하지 않고 STALE로 기록한다 (BR-O05)
      const order = deps.orders.get(request.tenantId, cancellation.orderId)!;
      const stale = request.decision === "APPROVED" && order.version !== cancellation.baseVersion;
      const decision: OrderCancellationDecision = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        requestId: cancellation.id,
        kind: stale ? "STALE" : request.decision,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt,
        ...(request.note === undefined ? {} : { note: request.note }),
        recordedAt: now.toISOString(),
      };
      deps.orderCancellationDecisions.save(decision);
      return decision;
    },
  );
}
