import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { parseUtcTimestamp } from "../procurement/validation";
import type { FulfillmentCorrectionRepository } from "../fulfillment/correctFulfillment";
import type { PaymentCorrectionRepository } from "../payment/correctPayment";
import type { OrderRepository } from "./confirmOrderService";
import {
  evaluateOrderClosure,
  type ClosureBlocker,
  type EvaluateOrderClosureDeps,
} from "./evaluateOrderClosure";

export type ReopeningTrigger =
  | { kind: "PAYMENT_CORRECTION"; id: string }
  | { kind: "FULFILLMENT_CORRECTION"; id: string };

/**
 * 종결 후 승인된 정정으로 종결 조건이 깨져 주문을 재개한 서버 기록 (추가 전용, ST-O10).
 * 정정 자체(역거래)는 원거래를 보존한 별도 기록이며, 이 기록은 그 결과로 재개했다는 사실이다.
 */
export type OrderReopening = {
  id: string;
  tenantId: string;
  orderId: string;
  trigger: ReopeningTrigger;
  blockers: ClosureBlocker[];
  orderVersionBefore: number;
  orderVersionAfter: number;
  executedBy: "SYSTEM";
  reopenedAt: string;
  recordedAt: string;
};

export type OrderReopeningRepository = {
  list(tenantId: string, orderId: string): OrderReopening[];
  save(reopening: OrderReopening): void;
};

export type ExecuteOrderReopeningDeps = EvaluateOrderClosureDeps & {
  orders: OrderRepository;
  paymentCorrections: PaymentCorrectionRepository;
  /** 수령 정정(ST-F02)을 재개 근거로 받으려면 필요하다 */
  fulfillmentCorrections?: Pick<FulfillmentCorrectionRepository, "list">;
  orderReopenings: OrderReopeningRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ExecuteOrderReopeningRequest = {
  tenantId: string;
  orderId: string;
  trigger: ReopeningTrigger;
  executedBy: "SYSTEM";
  executedAt: string;
  idempotencyKey: string;
};

export function executeOrderReopening(
  deps: ExecuteOrderReopeningDeps,
  request: ExecuteOrderReopeningRequest,
): OrderReopening {
  // 재개는 서버 내부 업무다. 정정(역거래)은 Owner 승인으로 이미 기록되어 있어야 한다 (D21, BR-O07)
  if (request.executedBy !== "SYSTEM") {
    throw new AppError("FORBIDDEN");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("executedAt", request.executedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "order.execute-reopening",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        trigger: request.trigger,
        executedBy: request.executedBy,
        executedAt: request.executedAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) {
        throw new AppError("NOT_FOUND");
      }
      const triggerId = request.trigger.id;
      const correction =
        request.trigger.kind === "FULFILLMENT_CORRECTION"
          ? deps.fulfillmentCorrections?.list(request.tenantId, order.id).find((c) => c.id === triggerId)
          : deps.paymentCorrections.get(request.tenantId, triggerId);
      if (!correction) {
        throw new AppError("NOT_FOUND");
      }
      if (correction.orderId !== order.id) {
        throw new AppError("BUSINESS_INVARIANT", "the correction does not belong to this order");
      }
      if (order.closedAt === undefined) {
        throw new AppError("BUSINESS_INVARIANT", "only a closed order can be reopened");
      }
      // 정정 적용 뒤 종결 조건을 다시 평가한다. 여전히 충족하면 기존 종결 상태를 보존한다 (BR-O07)
      const evaluation = evaluateOrderClosure(deps, request.tenantId, order);
      if (evaluation.closable) {
        throw new AppError("BUSINESS_INVARIANT", "closure conditions are still satisfied");
      }
      const reopening: OrderReopening = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: order.id,
        trigger: request.trigger,
        blockers: evaluation.blockers,
        orderVersionBefore: order.version,
        orderVersionAfter: order.version + 1,
        executedBy: "SYSTEM",
        reopenedAt: request.executedAt,
        recordedAt: now.toISOString(),
      };
      deps.orderReopenings.save(reopening);
      const { closedAt: _closedAt, ...rest } = order;
      void _closedAt;
      deps.orders.save({ ...rest, version: order.version + 1 });
      return reopening;
    },
  );
}
