import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { cancellationPending } from "./cancellationPending";
import type { ReturnExceptionRepository } from "./reportReturnException";
import type { ReturnExceptionResolutionRepository } from "./resolveReturnException";
import type { ReturnReplyRepository } from "./recordReturnReply";
import type { ReturnRequestRepository } from "./requestReturn";
import type { AllocationCancellationRepository } from "./cancelAllocation";
import type { StockMovement, StockMovementRepository } from "./registerInitialStock";

/** 취소 물량의 재고 편입 기록 (추가 전용). 원 입고·주문 참조를 보존한다 (ST-C06). */
export type StockIntake = {
  id: string;
  tenantId: string;
  bookId: string;
  cancellationId: string;
  receiptId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
  actedBy: string;
  actedAt: string;
  recordedAt: string;
};

export type StockIntakeRepository = {
  list(tenantId: string, cancellationId: string): StockIntake[];
  save(intake: StockIntake): void;
};

export type TransferCancelledToStockDeps = {
  allocationCancellations: Pick<AllocationCancellationRepository, "get">;
  stockIntakes: StockIntakeRepository;
  returnRequests: Pick<ReturnRequestRepository, "list">;
  returnReplies: Pick<ReturnReplyRepository, "list">;
  returnExceptions: Pick<ReturnExceptionRepository, "list">;
  returnExceptionResolutions: Pick<ReturnExceptionResolutionRepository, "list">;
  stockMovements: StockMovementRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type TransferCancelledToStockRequest = {
  tenantId: string;
  cancellationId: string;
  quantity: number;
  actorRole: "OWNER" | "STAFF";
  actedBy: string;
  actedAt: string;
  idempotencyKey: string;
};

export type TransferCancelledToStockResult = {
  intake: StockIntake;
  movement: StockMovement;
};

export function transferCancelledToStock(
  deps: TransferCancelledToStockDeps,
  request: TransferCancelledToStockRequest,
): TransferCancelledToStockResult {
  // 재고 편입 경로 결정은 점주 업무다 (DEC-18). Staff 승인 흐름은 아직 없어 기본 차단한다
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!isNonEmptyString(request.actedBy)) {
    invalid("actedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("actedAt", request.actedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.transfer-cancelled-to-stock",
      key: request.idempotencyKey,
      payload: {
        cancellationId: request.cancellationId,
        quantity: request.quantity,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
      },
    },
    () => {
      const cancellation = deps.allocationCancellations.get(request.tenantId, request.cancellationId);
      if (!cancellation) {
        throw new AppError("NOT_FOUND");
      }
      const pending = cancellationPending(deps, request.tenantId, cancellation);
      // 같은 취소 물량은 한 번만 처분한다: 반품 요청 중인 수량은 편입할 수 없다 (BR-Q15, ST-C06)
      if (request.quantity > pending) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "intake quantity must not exceed the cancellation's pending quantity",
        );
      }
      // 초기 재고가 등록되지 않은 도서의 원장은 만들 수 없다 (BR-Q22, ST-I02와 같은 전제)
      if (
        !deps.stockMovements
          .list(request.tenantId, cancellation.bookId)
          .some((m) => m.kind === "INITIAL")
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "initial stock must be registered before transferring cancelled books to stock",
        );
      }
      const recordedAt = now.toISOString();
      const intake: StockIntake = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: cancellation.bookId,
        cancellationId: cancellation.id,
        receiptId: cancellation.receiptId,
        orderId: cancellation.orderId,
        orderLineId: cancellation.orderLineId,
        quantity: request.quantity,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
        recordedAt,
      };
      const movement: StockMovement = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: cancellation.bookId,
        kind: "CANCEL_TO_STOCK",
        direction: "IN",
        quantity: request.quantity,
        reason: "취소 물량 재고 편입",
        cancellationId: cancellation.id,
        actedBy: request.actedBy,
        actedAt: request.actedAt,
        recordedAt,
      };
      deps.stockIntakes.save(intake);
      deps.stockMovements.save(movement);
      return { intake, movement };
    },
  );
}
