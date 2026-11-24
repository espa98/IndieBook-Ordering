import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import {
  invalid,
  isNonEmptyString,
  parseUtcTimestamp,
} from "../procurement/validation";
import type { CancellationRepository } from "../procurement/createCancellationRequest";
import type { PurchaseOrderRepository } from "../procurement/createPurchaseOrder";
import type { ReceiptCorrectionRepository } from "./correctReceipt";
import { poLineState } from "../procurement/poLineState";
import type { PoReplyRepository } from "../procurement/recordSupplierReply";

export type GoodsReceipt = {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  poLineId: string;
  normalQuantity: number;
  excessQuantity: number;
  damagedQuantity: number;
  misdeliveredQuantity: number;
  inspectedBy: string;
  receivedAt: string;
  recordedAt: string;
};

export type GoodsReceiptRepository = {
  get(tenantId: string, id: string): GoodsReceipt | undefined;
  list(tenantId: string, purchaseOrderId: string): GoodsReceipt[];
  save(receipt: GoodsReceipt): void;
};

export type ReceiveGoodsDeps = {
  purchaseOrders: PurchaseOrderRepository;
  receipts: GoodsReceiptRepository;
  /** 입고 정정은 정상 검수 순량을 줄여 미입고량을 늘린다 (BR-Q12) */
  receiptCorrections: ReceiptCorrectionRepository;
  replies: PoReplyRepository;
  /** 공급처가 수락한 취소가 유효 발주량을 줄이므로 필요하다 (DEC-04) */
  cancellations: CancellationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ReceiveGoodsRequest = {
  tenantId: string;
  purchaseOrderId: string;
  poLineId: string;
  normalQuantity: number;
  damagedQuantity: number;
  misdeliveredQuantity: number;
  inspectedBy: string;
  receivedAt: string;
  idempotencyKey: string;
};

export function receiveGoods(
  deps: ReceiveGoodsDeps,
  request: ReceiveGoodsRequest,
): GoodsReceipt {
  if (!isNonEmptyString(request.purchaseOrderId)) {
    invalid("purchaseOrderId", "must be a non-empty string");
  }
  if (!isNonEmptyString(request.poLineId)) {
    invalid("poLineId", "must be a non-empty string");
  }
  for (const field of [
    "normalQuantity",
    "damagedQuantity",
    "misdeliveredQuantity",
  ] as const) {
    const value: unknown = request[field];
    if (!Number.isInteger(value) || (value as number) < 0) {
      invalid(field, "must be an integer >= 0");
    }
  }
  if (
    request.normalQuantity + request.damagedQuantity + request.misdeliveredQuantity ===
    0
  ) {
    invalid("quantity", "at least one inspected quantity must be positive");
  }
  if (!isNonEmptyString(request.inspectedBy)) {
    invalid("inspectedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  const receivedAtMs = parseUtcTimestamp("receivedAt", request.receivedAt, now);

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "inventory.receive-goods",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        poLineId: request.poLineId,
        normalQuantity: request.normalQuantity,
        damagedQuantity: request.damagedQuantity,
        misdeliveredQuantity: request.misdeliveredQuantity,
        inspectedBy: request.inspectedBy,
        receivedAt: request.receivedAt,
      },
    },
    () => {
      const po = deps.purchaseOrders.get(request.tenantId, request.purchaseOrderId);
      if (!po) {
        // 없는 발주와 타 테넌트의 발주는 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      if (po.status !== "SENT" && po.status !== "ACKNOWLEDGED") {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "goods can only be received for a SENT or ACKNOWLEDGED purchase order",
        );
      }
      if (!po.lines.some((l) => l.poLineId === request.poLineId)) {
        throw new AppError("NOT_FOUND");
      }
      const line = po.lines.find((l) => l.poLineId === request.poLineId)!;
      const { qvalid } = poLineState(
        line.quantity,
        deps.replies
          .list(request.tenantId, po.id)
          .filter((r) => r.poLineId === line.poLineId),
        deps.cancellations
          .listResponses(request.tenantId, po.id)
          .filter((r) => r.poLineId === line.poLineId)
          .reduce((sum, r) => sum + r.acceptedQuantity, 0),
      );
      const lineReceipts = deps.receipts
        .list(request.tenantId, po.id)
        .filter((r) => r.poLineId === line.poLineId);
      const received =
        lineReceipts.reduce((sum, r) => sum + r.normalQuantity, 0) -
        lineReceipts
          .flatMap((r) => deps.receiptCorrections.list(request.tenantId, r.id))
          .reduce((sum, c) => sum + c.quantity, 0);
      // 정상 입고는 아직 받을 수 있는 양(Qopen)까지만, 넘는 만큼은 승인 전까지 별도로 둔다 (D30)
      const open = Math.max(0, qvalid - received);
      const posted = Math.min(request.normalQuantity, open);
      const receipt: GoodsReceipt = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        purchaseOrderId: request.purchaseOrderId,
        poLineId: request.poLineId,
        normalQuantity: posted,
        excessQuantity: request.normalQuantity - posted,
        damagedQuantity: request.damagedQuantity,
        misdeliveredQuantity: request.misdeliveredQuantity,
        inspectedBy: request.inspectedBy,
        receivedAt: new Date(receivedAtMs).toISOString(),
        recordedAt: now.toISOString(),
      };
      deps.receipts.save(receipt);
      return receipt;
    },
  );
}
