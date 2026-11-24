import type { PurchaseOrderRepository } from "../procurement/createPurchaseOrder";
import type { AllocationCancellationRepository } from "./cancelAllocation";
import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { cancellationPending } from "./cancellationPending";
import type { ReturnReplyRepository } from "./recordReturnReply";
import type { StockIntakeRepository } from "./transferCancelledToStock";
import type { GoodsReceiptRepository } from "./receiveGoods";

/** 공급처 반품 요청 (추가 전용). 원 입고·공급처·수량을 참조한다 (ST-C02). */
export type ReturnRequest = {
  id: string;
  tenantId: string;
  bookId: string;
  cancellationId: string;
  receiptId: string;
  supplierCode: string;
  quantity: number;
  requestedBy: string;
  requestedAt: string;
  recordedAt: string;
};

export type ReturnRequestRepository = {
  get(tenantId: string, id: string): ReturnRequest | undefined;
  list(tenantId: string, cancellationId: string): ReturnRequest[];
  save(request: ReturnRequest): void;
};

export type RequestReturnDeps = {
  allocationCancellations: Pick<AllocationCancellationRepository, "get">;
  receipts: GoodsReceiptRepository;
  purchaseOrders: PurchaseOrderRepository;
  returnRequests: ReturnRequestRepository;
  stockIntakes: Pick<StockIntakeRepository, "list">;
  returnReplies: Pick<ReturnReplyRepository, "list">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RequestReturnRequest = {
  tenantId: string;
  cancellationId: string;
  quantity: number;
  actorRole: "OWNER" | "STAFF";
  requestedBy: string;
  requestedAt: string;
  idempotencyKey: string;
};

export function requestReturn(
  deps: RequestReturnDeps,
  request: RequestReturnRequest,
): ReturnRequest {
  // 반품 경로 결정은 점주 업무다 (DEC-18). Staff 승인 흐름은 아직 없어 기본 차단한다
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!isNonEmptyString(request.requestedBy)) {
    invalid("requestedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("requestedAt", request.requestedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.request-return",
      key: request.idempotencyKey,
      payload: {
        cancellationId: request.cancellationId,
        quantity: request.quantity,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
      },
    },
    () => {
      const cancellation = deps.allocationCancellations.get(request.tenantId, request.cancellationId);
      if (!cancellation) {
        throw new AppError("NOT_FOUND");
      }
      const receipt = deps.receipts.get(request.tenantId, cancellation.receiptId)!;
      const po = deps.purchaseOrders.get(request.tenantId, receipt.purchaseOrderId)!;
      const pending = cancellationPending(deps, request.tenantId, cancellation);
      // 반품과 재고 편입은 같은 물량에 배타적이다 (BR-Q15, ST-C06)
      if (request.quantity > pending) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "return quantity must not exceed the cancellation's pending quantity",
        );
      }
      const returnRequest: ReturnRequest = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: cancellation.bookId,
        cancellationId: cancellation.id,
        receiptId: receipt.id,
        supplierCode: po.supplierCode,
        quantity: request.quantity,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        recordedAt: now.toISOString(),
      };
      deps.returnRequests.save(returnRequest);
      return returnRequest;
    },
  );
}
