import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { parseUtcTimestamp } from "../procurement/validation";
import { evaluateOrderClosure, type EvaluateOrderClosureDeps } from "./evaluateOrderClosure";
import type { OrderRepository } from "./confirmOrderService";
import type { OrderClosureRequestRepository } from "./requestOrderClosure";

/** 종결 실행 기록 (추가 전용). 서버가 재계산해 종결을 확정했다는 사실이다. */
export type OrderClosure = {
  id: string;
  tenantId: string;
  orderId: string;
  closureRequestId: string;
  orderVersionBefore: number;
  orderVersionAfter: number;
  executedBy: "SYSTEM";
  closedAt: string;
  recordedAt: string;
};

export type OrderClosureRepository = {
  list(tenantId: string, orderId: string): OrderClosure[];
  save(closure: OrderClosure): void;
};

export type ExecuteOrderClosureDeps = EvaluateOrderClosureDeps & {
  orders: OrderRepository;
  closureRequests: OrderClosureRequestRepository;
  orderClosures: OrderClosureRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ExecuteOrderClosureRequest = {
  tenantId: string;
  closureRequestId: string;
  executedBy: "SYSTEM";
  executedAt: string;
  idempotencyKey: string;
};

export function executeOrderClosure(
  deps: ExecuteOrderClosureDeps,
  request: ExecuteOrderClosureRequest,
): OrderClosure {
  // 종결 실행은 서버 내부 업무다. Staff·Owner는 요청만 할 수 있다 (BR-O03)
  if (request.executedBy !== "SYSTEM") {
    throw new AppError("FORBIDDEN");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("executedAt", request.executedAt, now);
  const closureRequest = deps.closureRequests.get(request.tenantId, request.closureRequestId);
  if (!closureRequest) {
    throw new AppError("NOT_FOUND");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "order.execute-closure",
      key: request.idempotencyKey,
      payload: {
        closureRequestId: request.closureRequestId,
        executedBy: request.executedBy,
        executedAt: request.executedAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, closureRequest.orderId)!;
      if (order.closedAt !== undefined) {
        throw new AppError("BUSINESS_INVARIANT", "the order is already closed");
      }
      // 요청 이후 주문이 바뀌었으면 STALE이다. 새 요청으로 다시 검토한다 (BR-O05, BR-O08)
      if (order.version !== closureRequest.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      // 요청 시점이 아니라 실행하는 지금 같은 호출에서 재계산한다 (BR-O03, BR-O08)
      const evaluation = evaluateOrderClosure(deps, request.tenantId, order);
      if (!evaluation.closable) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          `order cannot be closed: ${evaluation.blockers.join(", ")}`,
        );
      }
      const closure: OrderClosure = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: order.id,
        closureRequestId: closureRequest.id,
        orderVersionBefore: order.version,
        orderVersionAfter: order.version + 1,
        executedBy: "SYSTEM",
        closedAt: request.executedAt,
        recordedAt: now.toISOString(),
      };
      deps.orderClosures.save(closure);
      deps.orders.save({ ...order, version: order.version + 1, closedAt: request.executedAt });
      return closure;
    },
  );
}
