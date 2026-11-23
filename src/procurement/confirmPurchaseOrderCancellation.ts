import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { CancellationRepository } from "./createCancellationRequest";
import type {
  PurchaseOrder,
  PurchaseOrderRepository,
} from "./createPurchaseOrder";
import { poLineState } from "./poLineState";
import type { PoReplyRepository } from "./recordSupplierReply";
import { invalid, isNonEmptyString } from "./validation";

export type ConfirmPurchaseOrderCancellationDeps = {
  purchaseOrders: PurchaseOrderRepository;
  replies: PoReplyRepository;
  cancellations: CancellationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ConfirmPurchaseOrderCancellationRequest = {
  tenantId: string;
  purchaseOrderId: string;
  expectedVersion: number;
  idempotencyKey: string;
};

/**
 * 공급처가 발주 전량의 취소를 수락했음을 확정하고 SENT/ACKNOWLEDGED를 CANCELLED로 바꾼다 (ST-P10).
 * 취소 회신은 발주 상태를 바꾸지 않으므로(BR-P02) 상태 전이는 이 명령으로 별도로 확정한다.
 *
 * 조건: 모든 품목의 유효 발주량(Qvalid)이 0이고, 공급처가 수락한 취소 회신이 근거로 있어야 한다.
 * 모든 조건을 확인한 뒤에만 상태를 바꾼다.
 */
export function confirmPurchaseOrderCancellation(
  deps: ConfirmPurchaseOrderCancellationDeps,
  request: ConfirmPurchaseOrderCancellationRequest,
): PurchaseOrder {
  if (!isNonEmptyString(request.purchaseOrderId)) {
    invalid("purchaseOrderId", "must be a non-empty string");
  }
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    invalid("expectedVersion", "must be an integer >= 1");
  }

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.po-cancellation",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        expectedVersion: request.expectedVersion,
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
          "only a SENT or ACKNOWLEDGED purchase order can be cancelled by the supplier",
        );
      }
      if (po.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }

      const responses = deps.cancellations.listResponses(request.tenantId, po.id);
      const replies = deps.replies.list(request.tenantId, po.id);
      const everyLineFullyReduced = po.lines.every(
        (line) =>
          poLineState(
            line.quantity,
            replies.filter((r) => r.poLineId === line.poLineId),
            responses
              .filter((r) => r.poLineId === line.poLineId)
              .reduce((sum, r) => sum + r.acceptedQuantity, 0),
          ).qvalid === 0,
      );
      if (!everyLineFullyReduced) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "every line must have no remaining valid quantity before the purchase order can be cancelled",
        );
      }
      // 수락 근거: 공급처가 취소를 수락한 회신이 있어야 한다. 품절 확정만으로는 취소 수락이 아니다.
      if (!responses.some((r) => r.acceptedQuantity > 0)) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "an accepted cancellation response is required as the basis",
        );
      }

      const cancelled: PurchaseOrder = {
        ...po,
        status: "CANCELLED",
        version: po.version + 1,
        cancelledAt: (deps.now ?? (() => new Date()))().toISOString(),
      };
      deps.purchaseOrders.save(cancelled);
      return cancelled;
    },
  );
}
