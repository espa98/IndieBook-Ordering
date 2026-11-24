import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString } from "../procurement/validation";
import type { GoodsReceiptRepository } from "./receiveGoods";

/** 초과입고 결정 기록 (추가 전용). 입고 기록 자체는 바꾸지 않는다. */
export type ExcessDecision = {
  id: string;
  tenantId: string;
  receiptId: string;
  decision: "APPROVED" | "REJECTED";
  quantity: number;
  reason: string;
  decidedBy: string;
  decidedAt: string;
  recordedAt: string;
};

export type ExcessDecisionRepository = {
  list(tenantId: string, receiptId: string): ExcessDecision[];
  save(decision: ExcessDecision): void;
};

export type DecideExcessReceiptDeps = {
  receipts: GoodsReceiptRepository;
  excessDecisions: ExcessDecisionRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type DecideExcessReceiptRequest = {
  tenantId: string;
  receiptId: string;
  decision: ExcessDecision["decision"];
  quantity: number;
  reason: string;
  actorRole: "OWNER" | "STAFF";
  decidedBy: string;
  decidedAt: string;
  idempotencyKey: string;
};

export function decideExcessReceipt(
  deps: DecideExcessReceiptDeps,
  request: DecideExcessReceiptRequest,
): ExcessDecision {
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (!isNonEmptyString(request.reason)) {
    invalid("reason", "must be a non-empty string");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.decide-excess-receipt",
      key: request.idempotencyKey,
      payload: {
        receiptId: request.receiptId,
        decision: request.decision,
        quantity: request.quantity,
        reason: request.reason,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt,
      },
    },
    () => {
      const receipt = deps.receipts.get(request.tenantId, request.receiptId);
      if (!receipt) {
        throw new AppError("NOT_FOUND");
      }
      const decided = deps.excessDecisions
        .list(request.tenantId, receipt.id)
        .reduce((sum, d) => sum + d.quantity, 0);
      if (decided + request.quantity > receipt.excessQuantity) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "decided quantity must not exceed the receipt's excess quantity",
        );
      }
      const decision: ExcessDecision = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        receiptId: receipt.id,
        decision: request.decision,
        quantity: request.quantity,
        reason: request.reason,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt,
        recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
      };
      deps.excessDecisions.save(decision);
      return decision;
    },
  );
}
