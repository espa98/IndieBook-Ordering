import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { PurchaseOrder, PurchaseOrderRepository } from "./createPurchaseOrder";
import {
  evaluatePurchaseOrderClosure,
  type EvaluatePurchaseOrderClosureDeps,
} from "./evaluatePurchaseOrderClosure";
import { parseUtcTimestamp } from "./validation";

export type ExecutePurchaseOrderClosureDeps = EvaluatePurchaseOrderClosureDeps & {
  purchaseOrders: PurchaseOrderRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ExecutePurchaseOrderClosureRequest = {
  tenantId: string;
  purchaseOrderId: string;
  expectedVersion: number;
  executedBy: "SYSTEM";
  executedAt: string;
  idempotencyKey: string;
};

/** 서버 내부 업무로 발주를 종결한다 (ST-P11, BR-P06). 종결 조건은 실행하는 지금 재계산한다. */
export function executePurchaseOrderClosure(
  deps: ExecutePurchaseOrderClosureDeps,
  request: ExecutePurchaseOrderClosureRequest,
): PurchaseOrder {
  // 종결 실행은 서버 내부 업무다 (ST-P11 주체 SYS)
  if (request.executedBy !== "SYSTEM") {
    throw new AppError("FORBIDDEN");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("executedAt", request.executedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.execute-po-closure",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        expectedVersion: request.expectedVersion,
        executedBy: request.executedBy,
        executedAt: request.executedAt,
      },
    },
    () => {
      const po = deps.purchaseOrders.get(request.tenantId, request.purchaseOrderId);
      if (!po) {
        throw new AppError("NOT_FOUND");
      }
      if (po.status !== "SENT" && po.status !== "ACKNOWLEDGED") {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "only a SENT or ACKNOWLEDGED purchase order can be closed",
        );
      }
      if (po.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      // 요청 시점이 아니라 실행하는 지금 재계산한다
      const evaluation = evaluatePurchaseOrderClosure(deps, request.tenantId, po);
      if (!evaluation.closable) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          `purchase order cannot be closed: ${evaluation.blockers.join(", ")}`,
        );
      }
      const closed: PurchaseOrder = {
        ...po,
        status: "CLOSED",
        version: po.version + 1,
        closedAt: request.executedAt,
      };
      deps.purchaseOrders.save(closed);
      return closed;
    },
  );
}
