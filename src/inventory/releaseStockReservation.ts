import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { StockReservationRepository } from "./stockReservation";

/** 재고 예약 해제 기록 (추가 전용). 원 예약과 재고 원장(보유)은 바꾸지 않는다 (ST-I04). */
export type StockReservationRelease = {
  id: string;
  tenantId: string;
  bookId: string;
  reservationId: string;
  quantity: number;
  reason: string;
  releasedBy: string;
  releasedAt: string;
  recordedAt: string;
};

export type StockReservationReleaseRepository = {
  list(tenantId: string, reservationId: string): StockReservationRelease[];
  save(release: StockReservationRelease): void;
};

export type ReleaseStockReservationDeps = {
  stockReservations: StockReservationRepository;
  stockReservationReleases: StockReservationReleaseRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ReleaseStockReservationRequest = {
  tenantId: string;
  reservationId: string;
  quantity: number;
  reason: string;
  releasedBy: string;
  releasedAt: string;
  idempotencyKey: string;
};

export function releaseStockReservation(
  deps: ReleaseStockReservationDeps,
  request: ReleaseStockReservationRequest,
): StockReservationRelease {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["reason", "releasedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("releasedAt", request.releasedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.release-stock-reservation",
      key: request.idempotencyKey,
      payload: {
        reservationId: request.reservationId,
        quantity: request.quantity,
        reason: request.reason,
        releasedBy: request.releasedBy,
        releasedAt: request.releasedAt,
      },
    },
    () => {
      const reservation = deps.stockReservations.get(request.tenantId, request.reservationId);
      if (!reservation) {
        throw new AppError("NOT_FOUND");
      }
      const released = deps.stockReservationReleases
        .list(request.tenantId, reservation.id)
        .reduce((sum, r) => sum + r.quantity, 0);
      if (request.quantity > reservation.quantity - released) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "released quantity must not exceed the reservation's remaining quantity",
        );
      }
      const release: StockReservationRelease = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: reservation.bookId,
        reservationId: reservation.id,
        quantity: request.quantity,
        reason: request.reason,
        releasedBy: request.releasedBy,
        releasedAt: request.releasedAt,
        recordedAt: now.toISOString(),
      };
      deps.stockReservationReleases.save(release);
      return release;
    },
  );
}
