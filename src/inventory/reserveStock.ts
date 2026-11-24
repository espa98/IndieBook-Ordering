import { AppError } from "../errors/AppError";
import { assertOrderOpenForTransactions } from "../order/orderGuards";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { SourcingAllocationRepository } from "../procurement/allocateSourcing";
import type { OrderRepository } from "../order/confirmOrderService";
import { stockLevel } from "./stockLevel";
import type { StockMovementRepository } from "./registerInitialStock";
import {
  readReservationLedger,
  type StockReservation,
  type StockReservationRepository,
} from "./stockReservation";
import type { StockReservationDeliveryRepository } from "./deliverStockReservation";
import type { StockReservationReleaseRepository } from "./releaseStockReservation";

/** 예약 기록. 생성 근거(담당자·업무 시각·기록 시각)를 함께 남긴다. */
export type StockReservationRecord = StockReservation & {
  reservedBy: string;
  reservedAt: string;
  recordedAt: string;
};

export type ReserveStockDeps = {
  orders: OrderRepository;
  /** 활성 조달 배정은 아직 확보로 전환되지 않은 계획량이라 미배정량에서 뺀다 (BR-Q07) */
  sourcingAllocations: Pick<SourcingAllocationRepository, "list">;
  stockMovements: StockMovementRepository;
  stockReservations: StockReservationRepository;
  stockReservationReleases: StockReservationReleaseRepository;
  stockReservationDeliveries: Pick<StockReservationDeliveryRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ReserveStockRequest = {
  tenantId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  reservedBy: string;
  reservedAt: string;
  idempotencyKey: string;
};

export function reserveStock(
  deps: ReserveStockDeps,
  request: ReserveStockRequest,
): StockReservationRecord {
  for (const field of ["orderId", "orderLineId", "reservedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("reservedAt", request.reservedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.reserve-stock",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        orderLineId: request.orderLineId,
        quantity: request.quantity,
        reservedBy: request.reservedBy,
        reservedAt: request.reservedAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      const line = order?.lines.find((l) => l.lineId === request.orderLineId);
      if (!order || !line) {
        // 없는 대상과 타 테넌트의 대상은 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      assertOrderOpenForTransactions(order, "reserving stock");
      const { reservations, releases, deliveries } = readReservationLedger(
        deps,
        request.tenantId,
        line.bookId,
      );
      const { available } = stockLevel(
        deps.stockMovements.list(request.tenantId, line.bookId),
        reservations,
        releases,
        deliveries,
      );
      if (request.quantity > available) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "reserved quantity must not exceed the available stock",
        );
      }
      // 미배정량 Unassigned = Need - Planned 를 넘을 수 없다 (BR-Q06~Q08)
      const reservedForLine =
        reservations
          .filter((r) => r.orderId === order.id && r.orderLineId === line.lineId)
          .reduce((sum, r) => sum + r.quantity, 0) -
        releases
          .filter((rel) =>
            reservations.some(
              (r) =>
                r.id === rel.reservationId &&
                r.orderId === order.id &&
                r.orderLineId === line.lineId,
            ),
          )
          .reduce((sum, rel) => sum + rel.quantity, 0);
      const planned = deps.sourcingAllocations
        .list(request.tenantId)
        .filter((a) => a.orderId === order.id && a.lineId === line.lineId && a.status === "ACTIVE")
        .reduce((sum, a) => sum + a.quantity, 0);
      if (request.quantity > line.quantity - reservedForLine - planned) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "reserved quantity must not exceed the order line's unassigned quantity",
        );
      }
      const reservation: StockReservationRecord = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: line.bookId,
        orderId: order.id,
        orderLineId: line.lineId,
        quantity: request.quantity,
        reservedBy: request.reservedBy,
        reservedAt: request.reservedAt,
        recordedAt: now.toISOString(),
      };
      deps.stockReservations.save(reservation);
      return reservation;
    },
  );
}
