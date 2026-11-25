import { AppError } from "../errors/AppError";
import { assertOrderOpenForTransactions } from "../order/orderGuards";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { PaymentConfirmationRepository } from "../payment/confirmPayment";
import { paymentSummary } from "../payment/paymentSummary";
import type { PaymentRepository } from "../payment/recordPayment";
import type { PaymentVoidRepository } from "../payment/voidPayment";
import { activeCancellationLock } from "../order/orderCancellationState";
import type {
  OrderCancellationDecisionRepository,
  OrderCancellationRequestRepository,
} from "../order/requestOrderCancellation";
import type { OrderRepository } from "../order/confirmOrderService";
import {
  planAllocationDelivery,
  validateDeliverAllocationRequest,
  type AllocationDelivery,
  type DeliverAllocationDeps,
} from "../inventory/deliverAllocation";
import {
  planStockReservationDelivery,
  validateDeliverStockReservationRequest,
  type DeliverStockReservationDeps,
  type DeliverStockReservationResult,
} from "../inventory/deliverStockReservation";

export type FulfillmentSource = {
  kind: "STOCK_RESERVATION" | "RECEIPT_ALLOCATION";
  sourceId: string;
  quantity: number;
};

/** 수령(인도) 거래 (추가 전용, ST-F01). 인도한 출처와 당시 단가 스냅샷을 보존한다. */
export type Fulfillment = {
  id: string;
  tenantId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  unitPriceKrw: string;
  amountKrw: string;
  sources: FulfillmentSource[];
  receivedBy: string;
  receivedAt: string;
  recordedAt: string;
  /** 정정 역거래 행이면 원 수령 참조. 수량·금액은 음수이며 순 수령량 합계에 그대로 합산된다 (ST-F02) */
  correctsFulfillmentId?: string;
};

export type FulfillmentRepository = {
  list(tenantId: string, orderId: string): Fulfillment[];
  save(fulfillment: Fulfillment): void;
};

export type PostFulfillmentDeps = DeliverStockReservationDeps & DeliverAllocationDeps & {
  orders: OrderRepository;
  fulfillments: FulfillmentRepository;
  idempotency: IdempotencyStore;
  /** 진행 중인 취소 요청의 수량은 잠겨 인도할 수 없다 (D27) */
  orderCancellationRequests: Pick<OrderCancellationRequestRepository, "list">;
  orderCancellationDecisions: Pick<OrderCancellationDecisionRepository, "list">;
  payments: PaymentRepository;
  paymentConfirmations: Pick<PaymentConfirmationRepository, "list">;
  paymentVoids: Pick<PaymentVoidRepository, "list">;
};

export type PostFulfillmentRequest = {
  tenantId: string;
  orderId: string;
  orderLineId: string;
  sources: FulfillmentSource[];
  receivedBy: string;
  receivedAt: string;
  idempotencyKey: string;
};

export function postFulfillment(
  deps: PostFulfillmentDeps,
  request: PostFulfillmentRequest,
): Fulfillment {
  if (!isNonEmptyString(request.orderLineId)) {
    invalid("orderLineId", "must be a non-empty string");
  }
  if (!Array.isArray(request.sources) || request.sources.length === 0) {
    invalid("sources", "must be a non-empty array");
  }
  for (const source of request.sources) {
    if (source.kind !== "STOCK_RESERVATION" && source.kind !== "RECEIPT_ALLOCATION") {
      invalid("sources.kind", "must be STOCK_RESERVATION or RECEIPT_ALLOCATION");
    }
    if (!isNonEmptyString(source.sourceId)) {
      invalid("sources.sourceId", "must be a non-empty string");
    }
    if (!Number.isInteger(source.quantity) || source.quantity < 1) {
      invalid("sources.quantity", "must be an integer >= 1");
    }
  }
  if (!isNonEmptyString(request.receivedBy)) {
    invalid("receivedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("receivedAt", request.receivedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "fulfillment.post",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        orderLineId: request.orderLineId,
        sources: request.sources.map((src) => ({
          kind: src.kind,
          sourceId: src.sourceId,
          quantity: src.quantity,
        })),
        receivedBy: request.receivedBy,
        receivedAt: request.receivedAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      const line = order?.lines.find((l) => l.lineId === request.orderLineId);
      if (!order || !line) {
        // 없는 대상과 타 테넌트의 대상은 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      assertOrderOpenForTransactions(order, "fulfillment");
      const quantity = request.sources.reduce((sum, s) => sum + s.quantity, 0);
      // 유효 수량 E - 기수령 F - 취소 요청으로 잠긴 수량 이내만 인도할 수 있다 (D27)
      const received = deps.fulfillments
        .list(request.tenantId, order.id)
        .filter((f) => f.orderLineId === line.lineId)
        .reduce((sum, f) => sum + f.quantity, 0);
      const locked = activeCancellationLock(
        deps.orderCancellationRequests.list(request.tenantId, order.id),
        (requestId) => deps.orderCancellationDecisions.list(request.tenantId, requestId),
        line.lineId,
      );
      if (quantity > line.quantity - received - locked) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "delivery quantity must not exceed the order line's unlocked undelivered quantity",
        );
      }
      const amount = BigInt(quantity) * BigInt(line.unitPriceKrw);
      // 후불 인도는 기본 금지: 이번 인도를 포함한 누적 인도 금액이 직원이 확인한 결제액 이내여야 한다 (DEC-11)
      const payments = deps.payments.list(request.tenantId, order.id);
      const { confirmedKrw } = paymentSummary(
        order,
        payments,
        payments.flatMap((p) => deps.paymentConfirmations.list(request.tenantId, p.id)),
        payments.flatMap((p) => deps.paymentVoids.list(request.tenantId, p.id)),
      );
      const alreadyDelivered = deps.fulfillments
        .list(request.tenantId, order.id)
        .reduce((sum, f) => sum + BigInt(f.amountKrw), 0n);
      if (alreadyDelivered + amount > BigInt(confirmedKrw)) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "confirmed payment does not cover the delivery amount",
        );
      }
      // 모든 출처를 먼저 검증·계획하고(앞선 계획분을 반영), 전부 통과한 뒤에만 함께 저장한다 (원자 처리)
      const planned: DeliverStockReservationResult[] = [];
      const plannedAllocations: AllocationDelivery[] = [];
      const view = {
        ...deps,
        stockReservationDeliveries: {
          ...deps.stockReservationDeliveries,
          list: (tenantId: string, reservationId: string) => [
            ...deps.stockReservationDeliveries.list(tenantId, reservationId),
            ...planned.filter((p) => p.delivery.reservationId === reservationId).map((p) => p.delivery),
          ],
        },
      };
      const allocationView = {
        ...deps,
        allocationDeliveries: {
          ...deps.allocationDeliveries,
          list: (tenantId: string, allocationId: string) => [
            ...deps.allocationDeliveries.list(tenantId, allocationId),
            ...plannedAllocations.filter((d) => d.allocationId === allocationId),
          ],
        },
      };
      for (const source of request.sources) {
        if (source.kind === "RECEIPT_ALLOCATION") {
          // 입고 배분 출처도 이 주문 품목에 배분된 물량이어야 한다
          const allocation = deps.receiptAllocations.get(request.tenantId, source.sourceId);
          if (allocation && (allocation.orderId !== order.id || allocation.orderLineId !== line.lineId)) {
            throw new AppError(
              "BUSINESS_INVARIANT",
              "the source allocation does not belong to this order line",
            );
          }
          const allocationRequest = {
            tenantId: request.tenantId,
            allocationId: source.sourceId,
            quantity: source.quantity,
            deliveredBy: request.receivedBy,
            deliveredAt: request.receivedAt,
            idempotencyKey: request.idempotencyKey,
          };
          validateDeliverAllocationRequest(allocationRequest, now);
          plannedAllocations.push(planAllocationDelivery(allocationView, allocationRequest, now));
          continue;
        }
        // 출처 물량은 이 주문 품목의 것이어야 한다. 다른 주문의 물량으로 인도할 수 없다
        const reservation = deps.stockReservations.get(request.tenantId, source.sourceId);
        if (
          reservation &&
          (reservation.orderId !== order.id || reservation.orderLineId !== line.lineId)
        ) {
          throw new AppError(
            "BUSINESS_INVARIANT",
            "the source stock does not belong to this order line",
          );
        }
        const deliverRequest = {
          tenantId: request.tenantId,
          reservationId: source.sourceId,
          quantity: source.quantity,
          deliveredBy: request.receivedBy,
          deliveredAt: request.receivedAt,
          idempotencyKey: request.idempotencyKey,
        };
        validateDeliverStockReservationRequest(deliverRequest, now);
        planned.push(planStockReservationDelivery(view, deliverRequest, now));
      }
      for (const { delivery, movement } of planned) {
        deps.stockReservationDeliveries.save(delivery);
        deps.stockMovements.save(movement);
      }
      for (const delivery of plannedAllocations) {
        deps.allocationDeliveries.save(delivery);
      }
      const fulfillment: Fulfillment = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: order.id,
        orderLineId: line.lineId,
        quantity,
        unitPriceKrw: line.unitPriceKrw,
        amountKrw: amount.toString(),
        sources: request.sources.map((s) => ({ ...s })),
        receivedBy: request.receivedBy,
        receivedAt: request.receivedAt,
        recordedAt: now.toISOString(),
      };
      deps.fulfillments.save(fulfillment);
      return fulfillment;
    },
  );
}
