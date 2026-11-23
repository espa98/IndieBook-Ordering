import {
  authorizeTenantAccess,
  type MembershipRepository,
} from "../auth/authorizeTenantAccess";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import {
  confirmOrderService,
  type ConfirmOrderRequest,
  type OrderRepository,
} from "./confirmOrderService";
import {
  createOrderService,
  type CreateOrderRequest,
} from "./createOrderService";
import { getOrder, toOrderDetail } from "./getOrder";
import { listOrders } from "./listOrders";

export type OrderApiDeps = {
  orders: OrderRepository;
  memberships: MembershipRepository;
  idempotency: IdempotencyStore;
  issueDisplayNumber: (tenantId: string) => number;
};

export type Actor = { userId: string };

export function createOrderApi(deps: OrderApiDeps) {
  /**
   * 모든 공개 메서드는 이 래퍼를 통해서만 만든다.
   * 권한 검사(활성 membership)가 업무 로직 호출보다 항상 먼저 실행된다.
   */
  function guarded<Request extends { tenantId: string }, Result>(
    run: (request: Request) => Result,
  ) {
    return (actor: Actor, request: Request): Result => {
      authorizeTenantAccess(
        { memberships: deps.memberships },
        { userId: actor.userId, tenantId: request.tenantId },
      );
      return run(request);
    };
  }

  return {
    listOrders: guarded((request: Parameters<typeof listOrders>[1]) =>
      listOrders({ orders: deps.orders }, request),
    ),

    getOrder: guarded((request: Parameters<typeof getOrder>[1]) =>
      getOrder({ orders: deps.orders }, request),
    ),

    createOrder: guarded((request: CreateOrderRequest) =>
      toOrderDetail(
        createOrderService(
          { orders: deps.orders, idempotency: deps.idempotency },
          request,
        ),
      ),
    ),

    confirmOrder: guarded((request: ConfirmOrderRequest) =>
      toOrderDetail(
        confirmOrderService(
          {
            orders: deps.orders,
            idempotency: deps.idempotency,
            issueDisplayNumber: deps.issueDisplayNumber,
          },
          request,
        ),
      ),
    ),
  };
}
