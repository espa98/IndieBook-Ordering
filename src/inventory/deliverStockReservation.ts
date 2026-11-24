import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { StockReservationReleaseRepository } from "./releaseStockReservation";
import type { StockMovement, StockMovementRepository } from "./registerInitialStock";
import type { StockReservationRepository } from "./stockReservation";

/** 예약 인도 기록 (추가 전용). 원 예약은 바꾸지 않는다 (ST-I05). */
export type StockReservationDelivery = {
  id: string;
  tenantId: string;
  bookId: string;
  reservationId: string;
  quantity: number;
  deliveredBy: string;
  deliveredAt: string;
  recordedAt: string;
};

export type StockReservationDeliveryRepository = {
  list(tenantId: string, reservationId: string): StockReservationDelivery[];
  save(delivery: StockReservationDelivery): void;
};

export type DeliverStockReservationDeps = {
  stockReservations: StockReservationRepository;
  stockReservationReleases: StockReservationReleaseRepository;
  stockReservationDeliveries: StockReservationDeliveryRepository;
  stockMovements: StockMovementRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type DeliverStockReservationRequest = {
  tenantId: string;
  reservationId: string;
  quantity: number;
  deliveredBy: string;
  deliveredAt: string;
  idempotencyKey: string;
};

export type DeliverStockReservationResult = {
  delivery: StockReservationDelivery;
  movement: StockMovement;
};

export function deliverStockReservation(
  deps: DeliverStockReservationDeps,
  request: DeliverStockReservationRequest,
): DeliverStockReservationResult {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!isNonEmptyString(request.deliveredBy)) {
    invalid("deliveredBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("deliveredAt", request.deliveredAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.deliver-stock-reservation",
      key: request.idempotencyKey,
      payload: {
        reservationId: request.reservationId,
        quantity: request.quantity,
        deliveredBy: request.deliveredBy,
        deliveredAt: request.deliveredAt,
      },
    },
    () => {
      const reservation = deps.stockReservations.get(request.tenantId, request.reservationId);
      if (!reservation) {
        throw new AppError("NOT_FOUND");
      }
      const sum = (items: { quantity: number }[]) =>
        items.reduce((total, i) => total + i.quantity, 0);
      const released = sum(deps.stockReservationReleases.list(request.tenantId, reservation.id));
      const delivered = sum(deps.stockReservationDeliveries.list(request.tenantId, reservation.id));
      // 미인도 예약 잔량 B = G - L - F 만 인도할 수 있다 (BR-Q16)
      if (request.quantity > reservation.quantity - released - delivered) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "delivered quantity must not exceed the reservation's remaining quantity",
        );
      }
      const recordedAt = now.toISOString();
      const delivery: StockReservationDelivery = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: reservation.bookId,
        reservationId: reservation.id,
        quantity: request.quantity,
        deliveredBy: request.deliveredBy,
        deliveredAt: request.deliveredAt,
        recordedAt,
      };
      const movement: StockMovement = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: reservation.bookId,
        kind: "DELIVERY",
        direction: "OUT",
        quantity: request.quantity,
        reason: "예약 인도",
        reservationId: reservation.id,
        actedBy: request.deliveredBy,
        actedAt: request.deliveredAt,
        recordedAt,
      };
      deps.stockReservationDeliveries.save(delivery);
      deps.stockMovements.save(movement);
      return { delivery, movement };
    },
  );
}
