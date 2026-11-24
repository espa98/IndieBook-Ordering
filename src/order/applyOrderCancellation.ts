import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { orderCancellationStatus } from "./orderCancellationState";
import type { FulfillmentRepository } from "../fulfillment/postFulfillment";
import { allocationState } from "../inventory/allocationState";
import { cancelAllocation, type CancelAllocationDeps } from "../inventory/cancelAllocation";
import { releaseStockReservation } from "../inventory/releaseStockReservation";
import type { ReleaseStockReservationDeps } from "../inventory/releaseStockReservation";
import { readReservationLedger } from "../inventory/stockReservation";
import { openRefundTask, type OpenRefundTaskDeps } from "../payment/openRefundTask";
import { paymentSummary } from "../payment/paymentSummary";
import { refundTaskState } from "../payment/refundTaskState";
import type { OrderRepository } from "./confirmOrderService";
import type { Order } from "./createDraftOrder";
import type {
  OrderCancellationDecision,
  OrderCancellationDecisionRepository,
  OrderCancellationRequestRepository,
} from "./requestOrderCancellation";

export type ApplyOrderCancellationDeps = ReleaseStockReservationDeps & CancelAllocationDeps & OpenRefundTaskDeps & {
  orders: OrderRepository;
  fulfillments: Pick<FulfillmentRepository, "list">;
  orderCancellationRequests: OrderCancellationRequestRepository;
  orderCancellationDecisions: OrderCancellationDecisionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ApplyOrderCancellationRequest = {
  tenantId: string;
  requestId: string;
  actorRole: "OWNER" | "STAFF";
  appliedBy: string;
  appliedAt: string;
  idempotencyKey: string;
};

function totalOf(lines: Order["lines"]): string {
  return lines
    .reduce((sum, l) => sum + BigInt(l.quantity) * BigInt(l.unitPriceKrw), 0n)
    .toString();
}

/**
 * 승인된 취소 요청을 적용한다 (BR-O05/O06): 주문 수량·합계를 줄이고 version을 올리며,
 * 줄어든 필요량보다 많이 확보된 예약 물량을 해제한다.
 */
export function applyOrderCancellation(
  deps: ApplyOrderCancellationDeps,
  request: ApplyOrderCancellationRequest,
): OrderCancellationDecision {
  if (!isNonEmptyString(request.appliedBy)) {
    invalid("appliedBy", "must be a non-empty string");
  }
  parseUtcTimestamp("appliedAt", request.appliedAt, (deps.now ?? (() => new Date()))());
  // 적용은 Owner 업무다 (DEC-09)
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "order.apply-cancellation",
      key: request.idempotencyKey,
      payload: {
        requestId: request.requestId,
        appliedBy: request.appliedBy,
        appliedAt: request.appliedAt,
      },
    },
    () => {
      const cancellation = deps.orderCancellationRequests.get(request.tenantId, request.requestId);
      if (!cancellation) {
        throw new AppError("NOT_FOUND");
      }
      const order = deps.orders.get(request.tenantId, cancellation.orderId)!;
      if (
        orderCancellationStatus(deps.orderCancellationDecisions.list(request.tenantId, cancellation.id)) !==
        "APPROVED"
      ) {
        throw new AppError("BUSINESS_INVARIANT", "only an approved cancellation request can be applied");
      }
      // 승인 뒤 대상 주문이 바뀌었으면 적용하지 않고 STALE로 기록한다. 새 요청으로 다시 검토한다 (BR-O05)
      if (order.version !== cancellation.baseVersion) {
        const stale: OrderCancellationDecision = {
          id: crypto.randomUUID(),
          tenantId: request.tenantId,
          requestId: cancellation.id,
          kind: "STALE",
          decidedBy: request.appliedBy,
          decidedAt: request.appliedAt,
          recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
        };
        deps.orderCancellationDecisions.save(stale);
        return stale;
      }
      const line = order.lines.find((l) => l.lineId === cancellation.orderLineId)!;
      const lines = order.lines.map((l) =>
        l.lineId === line.lineId ? { ...l, quantity: l.quantity - cancellation.quantity } : l,
      );
      const received = deps.fulfillments
        .list(request.tenantId, order.id)
        .filter((f) => f.orderLineId === line.lineId)
        .reduce((sum, f) => sum + f.quantity, 0);
      const need = line.quantity - cancellation.quantity - received;

      const sum = (items: readonly { quantity: number }[]) =>
        items.reduce((total, i) => total + i.quantity, 0);
      const ledger = readReservationLedger(deps, request.tenantId, line.bookId);
      const reservations = ledger.reservations
        .filter((r) => r.orderId === order.id && r.orderLineId === line.lineId)
        .map((r) => ({
          reservation: r,
          remaining:
            r.quantity -
            sum(ledger.releases.filter((x) => x.reservationId === r.id)) -
            sum(ledger.deliveries.filter((x) => x.reservationId === r.id)),
        }));
      const allocations = deps.receiptAllocations
        .listByOrder(request.tenantId, order.id)
        .filter((a) => a.orderLineId === line.lineId)
        .map((a) => ({
          allocation: a,
          remaining: allocationState(
            a,
            deps.allocationReleases.list(request.tenantId, a.id),
            deps.allocationDeliveries.list(request.tenantId, a.id),
            deps.allocationCancellations.list(request.tenantId, a.id),
          ).remaining,
        }));
      // 새 필요량보다 많이 확보된 물량을 출처별로 정리한다: 예약은 해제, 입고 배분은 처분 대기로 (BR-O06, BR-Q21)
      let excess = sum(reservations.map((r) => ({ quantity: r.remaining }))) +
        sum(allocations.map((a) => ({ quantity: a.remaining }))) - need;
      const now = (deps.now ?? (() => new Date()))();
      for (const { reservation, remaining } of reservations) {
        const take = Math.min(remaining, excess);
        if (take <= 0) continue;
        releaseStockReservation(deps, {
          tenantId: request.tenantId,
          reservationId: reservation.id,
          quantity: take,
          reason: "주문 취소 적용으로 확보 초과분 해제",
          releasedBy: request.appliedBy,
          releasedAt: request.appliedAt,
          idempotencyKey: `${request.idempotencyKey}:release-${reservation.id}`,
        });
        excess -= take;
      }
      for (const { allocation, remaining } of allocations) {
        const take = Math.min(remaining, excess);
        if (take <= 0) continue;
        cancelAllocation(deps, {
          tenantId: request.tenantId,
          allocationId: allocation.id,
          quantity: take,
          reason: "주문 취소 적용으로 확보 초과분 처분 대기",
          actorRole: "OWNER",
          cancelledBy: request.appliedBy,
          cancelledAt: request.appliedAt,
          idempotencyKey: `${request.idempotencyKey}:cancel-${allocation.id}`,
        });
        excess -= take;
      }

      const updated: Order = {
        ...order,
        lines,
        totalKrw: totalOf(lines),
        version: order.version + 1,
        // 모든 품목의 유효 수량이 0이면 전량 취소(CANCELLING)다. 일부 취소는 CONFIRMED를 유지한다 (BR-O07)
        ...(lines.every((l) => l.quantity === 0) ? { cancelledAt: request.appliedAt } : {}),
      };
      deps.orders.save(updated);
      // 이미 확인된 결제가 줄어든 총액을 넘으면 물량과 독립인 환급 필요 업무를 연다 (ST-O05, ST-Y05)
      const payments = deps.payments.list(request.tenantId, order.id);
      const summary = paymentSummary(
        updated,
        payments,
        payments.flatMap((p) => deps.paymentConfirmations.list(request.tenantId, p.id)),
        payments.flatMap((p) => deps.paymentVoids.list(request.tenantId, p.id)),
        deps.refundConfirmations.listByOrder(request.tenantId, order.id),
        deps.paymentCorrections.listByOrder(request.tenantId, order.id),
      );
      const hasActiveTask = deps.refundTasks
        .list(request.tenantId, order.id)
        .some((t) => refundTaskState(t, deps.refundConfirmations.list(request.tenantId, t.id)).status !== "REFUNDED");
      if (BigInt(summary.refundRequiredKrw) > 0n && !hasActiveTask) {
        openRefundTask(deps, {
          tenantId: request.tenantId,
          orderId: order.id,
          openedBy: request.appliedBy,
          openedAt: request.appliedAt,
          idempotencyKey: `${request.idempotencyKey}:refund-task`,
        });
      }
      const decision: OrderCancellationDecision = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        requestId: cancellation.id,
        kind: "APPLIED",
        decidedBy: request.appliedBy,
        decidedAt: request.appliedAt,
        recordedAt: now.toISOString(),
      };
      deps.orderCancellationDecisions.save(decision);
      return decision;
    },
  );
}
