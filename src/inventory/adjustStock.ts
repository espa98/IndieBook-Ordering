import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { stockLevel } from "./stockLevel";
import type { StockReservationDeliveryRepository } from "./deliverStockReservation";
import type { StockReservationReleaseRepository } from "./releaseStockReservation";
import { readReservationLedger, type StockReservationRepository } from "./stockReservation";
import type {
  StockMovement,
  StockMovementRepository,
} from "./registerInitialStock";

export type AdjustStockDeps = {
  stockMovements: StockMovementRepository;
  idempotency: IdempotencyStore;
  /** 점주가 재고 조정을 명시적으로 위임한 직원만 조정할 수 있다 (DEC-19) */
  stockDelegations: { isDelegated(tenantId: string, userId: string): boolean };
  stockReservations: Pick<StockReservationRepository, "list">;
  stockReservationReleases: Pick<StockReservationReleaseRepository, "list">;
  stockReservationDeliveries: Pick<StockReservationDeliveryRepository, "list">;
  now?: () => Date;
};

export type AdjustStockRequest = {
  tenantId: string;
  bookId: string;
  direction: "IN" | "OUT";
  quantity: number;
  reason: string;
  actorRole: "OWNER" | "STAFF";
  actedBy: string;
  actedAt: string;
  idempotencyKey: string;
};

export function adjustStock(
  deps: AdjustStockDeps,
  request: AdjustStockRequest,
): StockMovement {
  for (const field of ["reason", "actedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  if (request.direction !== "IN" && request.direction !== "OUT") {
    invalid("direction", "must be IN or OUT");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("actedAt", request.actedAt, now);
  if (
    request.actorRole !== "OWNER" &&
    !deps.stockDelegations.isDelegated(request.tenantId, request.actedBy)
  ) {
    throw new AppError("FORBIDDEN");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.adjust-stock",
      key: request.idempotencyKey,
      payload: {
        bookId: request.bookId,
        direction: request.direction,
        quantity: request.quantity,
        reason: request.reason,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
      },
    },
    () => {
      const movements = deps.stockMovements.list(request.tenantId, request.bookId);
      if (!movements.some((m) => m.kind === "INITIAL")) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "initial stock must be registered before adjusting",
        );
      }
      const { reservations, releases, deliveries } = readReservationLedger(
        deps,
        request.tenantId,
        request.bookId,
      );
      const { onHand, reserved } = stockLevel(movements, reservations, releases, deliveries);
      // 조정 뒤에도 보유 >= 예약 >= 0 이어야 한다 (BR-Q09)
      if (request.direction === "OUT" && onHand - request.quantity < reserved) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "stock on hand must not go below the reserved quantity",
        );
      }
      const movement: StockMovement = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: request.bookId,
        kind: "ADJUST",
        direction: request.direction,
        quantity: request.quantity,
        reason: request.reason,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
        recordedAt: now.toISOString(),
      };
      deps.stockMovements.save(movement);
      return movement;
    },
  );
}
