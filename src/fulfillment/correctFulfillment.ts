import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { AllocationDeliveryRepository } from "../inventory/deliverAllocation";
import type { ReceiptAllocationRepository } from "../inventory/allocateReceipt";
import type { StockReservationDeliveryRepository } from "../inventory/deliverStockReservation";
import type { StockMovementRepository } from "../inventory/registerInitialStock";
import type { StockReservationRepository } from "../inventory/stockReservation";
import type { OrderRepository } from "../order/confirmOrderService";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { FulfillmentRepository, FulfillmentSource } from "./postFulfillment";

/**
 * 수령 오기록 정정 기록 (추가 전용, ST-F02, D21). 원 수령은 보존하고 음수 보정 행을 수령·인도 원장에 추가한다.
 * 실제 고객 반품은 이 경로로 처리할 수 없다 (BR-F03).
 */
export type FulfillmentCorrection = {
  id: string;
  tenantId: string;
  orderId: string;
  fulfillmentId: string;
  reversalFulfillmentId: string;
  quantity: number;
  restorations: FulfillmentSource[];
  reason: string;
  evidence: string;
  correctedBy: string;
  correctedAt: string;
  recordedAt: string;
};

export type FulfillmentCorrectionRepository = {
  list(tenantId: string, orderId: string): FulfillmentCorrection[];
  save(correction: FulfillmentCorrection): void;
};

export type CorrectFulfillmentDeps = {
  orders: OrderRepository;
  fulfillments: FulfillmentRepository;
  fulfillmentCorrections: FulfillmentCorrectionRepository;
  stockReservations: StockReservationRepository;
  stockReservationDeliveries: StockReservationDeliveryRepository;
  stockMovements: StockMovementRepository;
  receiptAllocations: Pick<ReceiptAllocationRepository, "get">;
  allocationDeliveries: AllocationDeliveryRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CorrectFulfillmentRequest = {
  tenantId: string;
  orderId: string;
  fulfillmentId: string;
  quantity: number;
  restorations: FulfillmentSource[];
  reason: string;
  evidence: string;
  physicalReturnConfirmed: boolean;
  actorRole: "OWNER" | "STAFF";
  correctedBy: string;
  correctedAt: string;
  idempotencyKey: string;
};

export function correctFulfillment(
  deps: CorrectFulfillmentDeps,
  request: CorrectFulfillmentRequest,
): FulfillmentCorrection {
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  // 불리언이 아닌 값은 형식 오류다. false(실물 반입 미확인)는 아래에서 업무 규칙으로 거부한다
  if (typeof request.physicalReturnConfirmed !== "boolean") {
    invalid("physicalReturnConfirmed", "must be a boolean");
  }
  if (!Array.isArray(request.restorations) || request.restorations.length === 0) {
    invalid("restorations", "must be a non-empty array");
  }
  for (const field of ["reason", "evidence", "correctedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("correctedAt", request.correctedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "fulfillment.correct",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        fulfillmentId: request.fulfillmentId,
        quantity: request.quantity,
        restorations: request.restorations,
        reason: request.reason,
        evidence: request.evidence,
        physicalReturnConfirmed: request.physicalReturnConfirmed,
        correctedBy: request.correctedBy,
        correctedAt: request.correctedAt,
      },
    },
    () => {
      const original = deps.fulfillments
        .list(request.tenantId, request.orderId)
        .find((f) => f.id === request.fulfillmentId);
      if (!original) {
        throw new AppError("NOT_FOUND");
      }
      // 실물이 매장으로 돌아왔음을 확인한 오기록 정정만 허용한다. 고객 반품은 별도 정책이다 (BR-F03)
      if (request.physicalReturnConfirmed !== true) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "the physical return of the goods must be confirmed before correcting a fulfillment",
        );
      }
      // 정정 가능 수량은 원 수령에서 이미 정정된 양을 뺀 만큼이고, 출처별로도 같다 (BR-F01, BR-Q16)
      const priorReversals = deps.fulfillments
        .list(request.tenantId, request.orderId)
        .filter((f) => f.correctsFulfillmentId === original.id);
      const correctable = (kind: FulfillmentSource["kind"], sourceId: string) => {
        const delivered = original.sources
          .filter((src) => src.kind === kind && src.sourceId === sourceId)
          .reduce((sum, src) => sum + src.quantity, 0);
        const corrected = priorReversals
          .flatMap((f) => f.sources)
          .filter((src) => src.kind === kind && src.sourceId === sourceId)
          .reduce((sum, src) => sum - src.quantity, 0);
        return delivered - corrected;
      };
      const restoredTotal = request.restorations.reduce((sum, r) => sum + r.quantity, 0);
      const alreadyCorrected = priorReversals.reduce((sum, f) => sum - f.quantity, 0);
      if (
        restoredTotal !== request.quantity ||
        request.quantity > original.quantity - alreadyCorrected ||
        request.restorations.some((r) => r.quantity > correctable(r.kind, r.sourceId))
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "correction must match its restorations and stay within the original fulfillment's uncorrected quantity per source",
        );
      }
      const recordedAt = now.toISOString();
      const reversalId = crypto.randomUUID();
      for (const source of request.restorations) {
        if (source.kind === "RECEIPT_ALLOCATION") {
          const allocation = deps.receiptAllocations.get(request.tenantId, source.sourceId)!;
          deps.allocationDeliveries.save({
            id: crypto.randomUUID(),
            tenantId: request.tenantId,
            allocationId: allocation.id,
            receiptId: allocation.receiptId,
            orderId: allocation.orderId,
            orderLineId: allocation.orderLineId,
            quantity: -source.quantity,
            deliveredBy: request.correctedBy,
            deliveredAt: request.correctedAt,
            recordedAt,
          });
          continue;
        }
        const reservation = deps.stockReservations.get(request.tenantId, source.sourceId)!;
        deps.stockReservationDeliveries.save({
          id: crypto.randomUUID(),
          tenantId: request.tenantId,
          bookId: reservation.bookId,
          reservationId: reservation.id,
          quantity: -source.quantity,
          deliveredBy: request.correctedBy,
          deliveredAt: request.correctedAt,
          recordedAt,
        });
        deps.stockMovements.save({
          id: crypto.randomUUID(),
          tenantId: request.tenantId,
          bookId: reservation.bookId,
          kind: "DELIVERY_REVERSAL",
          direction: "IN",
          quantity: source.quantity,
          reason: "수령 정정 복원",
          reservationId: reservation.id,
          actedBy: request.correctedBy,
          actedAt: request.correctedAt,
          recordedAt,
        });
      }
      deps.fulfillments.save({
        id: reversalId,
        tenantId: request.tenantId,
        orderId: original.orderId,
        orderLineId: original.orderLineId,
        quantity: -request.quantity,
        unitPriceKrw: original.unitPriceKrw,
        amountKrw: (-BigInt(request.quantity) * BigInt(original.unitPriceKrw)).toString(),
        sources: request.restorations.map((r) => ({ ...r, quantity: -r.quantity })),
        receivedBy: request.correctedBy,
        receivedAt: request.correctedAt,
        recordedAt,
        correctsFulfillmentId: original.id,
      });
      const correction: FulfillmentCorrection = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: original.orderId,
        fulfillmentId: original.id,
        reversalFulfillmentId: reversalId,
        quantity: request.quantity,
        restorations: request.restorations.map((r) => ({ ...r })),
        reason: request.reason,
        evidence: request.evidence,
        correctedBy: request.correctedBy,
        correctedAt: request.correctedAt,
        recordedAt,
      };
      deps.fulfillmentCorrections.save(correction);
      return correction;
    },
  );
}
