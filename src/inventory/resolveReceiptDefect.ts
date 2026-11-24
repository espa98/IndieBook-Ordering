import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { GoodsReceiptRepository } from "./receiveGoods";

/**
 * 검수에서 기록된 파손·오배송 수량의 처리 결과 (추가 전용, BR-P06).
 * 입고 기록은 바꾸지 않는다. 상세 반품 흐름은 P1이므로 결과만 증빙과 함께 남긴다.
 */
export type ReceiptDefectResolution = {
  id: string;
  tenantId: string;
  receiptId: string;
  purchaseOrderId: string;
  kind: "DAMAGED" | "MISDELIVERED";
  quantity: number;
  outcome: "RETURNED_TO_SUPPLIER" | "SUPPLIER_CREDIT" | "DISCARDED";
  evidence: string;
  resolvedBy: string;
  resolvedAt: string;
  recordedAt: string;
};

export type ReceiptDefectResolutionRepository = {
  list(tenantId: string, receiptId: string): ReceiptDefectResolution[];
  save(resolution: ReceiptDefectResolution): void;
};

export type ResolveReceiptDefectDeps = {
  receipts: Pick<GoodsReceiptRepository, "get">;
  receiptDefectResolutions: ReceiptDefectResolutionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ResolveReceiptDefectRequest = {
  tenantId: string;
  receiptId: string;
  kind: ReceiptDefectResolution["kind"];
  quantity: number;
  outcome: ReceiptDefectResolution["outcome"];
  evidence: string;
  actorRole: "OWNER" | "STAFF";
  resolvedBy: string;
  resolvedAt: string;
  idempotencyKey: string;
};

export function resolveReceiptDefect(
  deps: ResolveReceiptDefectDeps,
  request: ResolveReceiptDefectRequest,
): ReceiptDefectResolution {
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (request.kind !== "DAMAGED" && request.kind !== "MISDELIVERED") {
    invalid("kind", "must be DAMAGED or MISDELIVERED");
  }
  if (!["RETURNED_TO_SUPPLIER", "SUPPLIER_CREDIT", "DISCARDED"].includes(request.outcome)) {
    invalid("outcome", "must be RETURNED_TO_SUPPLIER, SUPPLIER_CREDIT or DISCARDED");
  }
  for (const field of ["evidence", "resolvedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  // 폐기는 재고 가치를 없애는 결정이라 Owner만 한다
  if (request.outcome === "DISCARDED" && request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("resolvedAt", request.resolvedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.resolve-receipt-defect",
      key: request.idempotencyKey,
      payload: {
        receiptId: request.receiptId,
        kind: request.kind,
        quantity: request.quantity,
        outcome: request.outcome,
        evidence: request.evidence,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
      },
    },
    () => {
      const receipt = deps.receipts.get(request.tenantId, request.receiptId);
      if (!receipt) {
        throw new AppError("NOT_FOUND");
      }
      // 종류별 처리 누적이 검수 때 기록된 수량을 넘을 수 없다
      const recorded =
        request.kind === "DAMAGED" ? receipt.damagedQuantity : receipt.misdeliveredQuantity;
      const resolved = deps.receiptDefectResolutions
        .list(request.tenantId, receipt.id)
        .filter((r) => r.kind === request.kind)
        .reduce((sum, r) => sum + r.quantity, 0);
      if (resolved + request.quantity > recorded) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "resolved quantity must not exceed the quantity recorded at inspection",
        );
      }
      const resolution: ReceiptDefectResolution = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        receiptId: receipt.id,
        purchaseOrderId: receipt.purchaseOrderId,
        kind: request.kind,
        quantity: request.quantity,
        outcome: request.outcome,
        evidence: request.evidence,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
        recordedAt: now.toISOString(),
      };
      deps.receiptDefectResolutions.save(resolution);
      return resolution;
    },
  );
}
