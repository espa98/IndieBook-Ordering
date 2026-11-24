import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { ReceiptAllocationRepository } from "./allocateReceipt";
import type { AllocationDeliveryRepository } from "./deliverAllocation";
import type { AllocationReleaseRepository } from "./releaseAllocation";
import { receiptBalances } from "./receiptBalances";
import type { GoodsReceiptRepository } from "./receiveGoods";

/** 입고 정정(정상량 차감) 보정 기록 (추가 전용). 원 입고 기록은 바꾸지 않는다 (ST-R03, BR-Q20). */
export type ReceiptCorrection = {
  id: string;
  tenantId: string;
  receiptId: string;
  quantity: number;
  reason: string;
  correctedBy: string;
  correctedAt: string;
  recordedAt: string;
};

export type ReceiptCorrectionRepository = {
  list(tenantId: string, receiptId: string): ReceiptCorrection[];
  save(correction: ReceiptCorrection): void;
};

export type CorrectReceiptDeps = {
  receipts: GoodsReceiptRepository;
  receiptAllocations: ReceiptAllocationRepository;
  allocationReleases: AllocationReleaseRepository;
  allocationDeliveries: AllocationDeliveryRepository;
  receiptCorrections: ReceiptCorrectionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CorrectReceiptRequest = {
  tenantId: string;
  receiptId: string;
  quantity: number;
  reason: string;
  actorRole: "OWNER" | "STAFF";
  correctedBy: string;
  correctedAt: string;
  idempotencyKey: string;
};

export function correctReceipt(
  deps: CorrectReceiptDeps,
  request: CorrectReceiptRequest,
): ReceiptCorrection {
  // 거래 정정은 Owner 승인 업무다 (DEC-09)
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  for (const field of ["reason", "correctedBy"] as const) {
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
      operation: "inventory.correct-receipt",
      key: request.idempotencyKey,
      payload: {
        receiptId: request.receiptId,
        quantity: request.quantity,
        reason: request.reason,
        correctedBy: request.correctedBy,
        correctedAt: request.correctedAt,
      },
    },
    () => {
      const receipt = deps.receipts.get(request.tenantId, request.receiptId);
      if (!receipt) {
        throw new AppError("NOT_FOUND");
      }
      const allocations = deps.receiptAllocations.list(request.tenantId, receipt.id);
      const flat = <T>(list: (allocationId: string) => T[]) =>
        allocations.flatMap((a) => list(a.id));
      const { UNALLOCATED } = receiptBalances(
        receipt,
        allocations,
        flat((id) => deps.allocationReleases.list(request.tenantId, id)),
        flat((id) => deps.allocationDeliveries.list(request.tenantId, id)),
        deps.receiptCorrections.list(request.tenantId, receipt.id),
      );
      // 실제로 취소할 수 있는 원 버킷은 미배분뿐이다. 배분·인도된 양은 먼저 해제 등으로 돌려놓아야 한다 (BR-Q20)
      if (request.quantity > UNALLOCATED) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "corrected quantity must not exceed the receipt's unallocated quantity",
        );
      }
      const correction: ReceiptCorrection = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        receiptId: receipt.id,
        quantity: request.quantity,
        reason: request.reason,
        correctedBy: request.correctedBy,
        correctedAt: request.correctedAt,
        recordedAt: now.toISOString(),
      };
      deps.receiptCorrections.save(correction);
      return correction;
    },
  );
}
