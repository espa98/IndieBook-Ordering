import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "./confirmOrderService";

/** 종결 요청 기록 (추가 전용). 요청은 주문을 바꾸지 않는다 — 종결은 서버가 재계산해 실행한다 (BR-O03). */
export type OrderClosureRequest = {
  id: string;
  tenantId: string;
  orderId: string;
  /** 요청 시점에 확인한 주문 version. 실행 시 다르면 STALE이다 (BR-O08) */
  expectedVersion: number;
  requestedBy: string;
  requestedAt: string;
  recordedAt: string;
};

export type OrderClosureRequestRepository = {
  get(tenantId: string, id: string): OrderClosureRequest | undefined;
  list(tenantId: string, orderId: string): OrderClosureRequest[];
  save(request: OrderClosureRequest): void;
};

export type RequestOrderClosureDeps = {
  orders: OrderRepository;
  closureRequests: OrderClosureRequestRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RequestOrderClosureRequest = {
  tenantId: string;
  orderId: string;
  expectedVersion: number;
  requestedBy: string;
  requestedAt: string;
  idempotencyKey: string;
};

export function requestOrderClosure(
  deps: RequestOrderClosureDeps,
  request: RequestOrderClosureRequest,
): OrderClosureRequest {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    invalid("expectedVersion", "must be an integer >= 1");
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
      operation: "order.request-closure",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        expectedVersion: request.expectedVersion,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) {
        throw new AppError("NOT_FOUND");
      }
      if (order.status !== "CONFIRMED") {
        throw new AppError("BUSINESS_INVARIANT", "only a confirmed order can be closed");
      }
      if (order.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      const closureRequest: OrderClosureRequest = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: order.id,
        expectedVersion: request.expectedVersion,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        recordedAt: now.toISOString(),
      };
      deps.closureRequests.save(closureRequest);
      return closureRequest;
    },
  );
}
