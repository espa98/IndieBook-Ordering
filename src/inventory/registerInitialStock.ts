import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";

/**
 * 매장 재고 수불 원장 항목 (추가 전용). 수량은 항상 양수이고 방향을 따로 둔다 (BR-Q22).
 * 고객 전용 입고 물량(입고 버킷)과 섞지 않는 매장 풀의 원장이다 (BR-Q18).
 */
export type StockMovement = {
  id: string;
  tenantId: string;
  bookId: string;
  kind: "INITIAL" | "ADJUST" | "DELIVERY" | "CANCEL_TO_STOCK";
  direction: "IN" | "OUT";
  quantity: number;
  reason: string;
  /** 예약 인도로 생긴 항목의 원 예약 참조 (정정·감사 추적용) */
  reservationId?: string;
  /** 취소 물량 재고 편입으로 생긴 항목의 원 취소 처분 참조 (ST-C06) */
  cancellationId?: string;
  actedBy: string;
  actedAt: string;
  recordedAt: string;
};

export type StockMovementRepository = {
  list(tenantId: string, bookId: string): StockMovement[];
  save(movement: StockMovement): void;
};

export type RegisterInitialStockDeps = {
  stockMovements: StockMovementRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RegisterInitialStockRequest = {
  tenantId: string;
  bookId: string;
  quantity: number;
  actorRole: "OWNER" | "STAFF";
  actedBy: string;
  actedAt: string;
  idempotencyKey: string;
};

export function registerInitialStock(
  deps: RegisterInitialStockDeps,
  request: RegisterInitialStockRequest,
): StockMovement {
  // 초기 재고 등록은 점주만 한다 (DEC-19)
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  for (const field of ["bookId", "actedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("actedAt", request.actedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.register-initial-stock",
      key: request.idempotencyKey,
      payload: {
        bookId: request.bookId,
        quantity: request.quantity,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
      },
    },
    () => {
      // 도서별 재고 키로 초기 재고 중복 등록을 막는다 (BR-Q22)
      if (
        deps.stockMovements
          .list(request.tenantId, request.bookId)
          .some((m) => m.kind === "INITIAL")
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "initial stock is already registered for this book",
        );
      }
      const movement: StockMovement = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: request.bookId,
        kind: "INITIAL",
        direction: "IN",
        quantity: request.quantity,
        reason: "초기 재고 등록",
        actedBy: request.actedBy,
        actedAt: request.actedAt,
        recordedAt: now.toISOString(),
      };
      deps.stockMovements.save(movement);
      return movement;
    },
  );
}
