import { authorizedActions } from "../auth/authorizedActions";
import {
  authorizeTenantAccess,
  type MembershipRepository,
} from "../auth/authorizeTenantAccess";
import type { UserPrincipal } from "../auth/principal";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import type { ConfirmOrderRequest, OrderRepository } from "./confirmOrderService";
import type { CreateOrderRequest } from "./createOrderService";
import { toOrderDetail } from "./getOrder";
import type { listOrders } from "./listOrders";

export type OrderApiDeps = {
  orders: OrderRepository;
  memberships: MembershipRepository;
  idempotency: IdempotencyStore;
  issueDisplayNumber: (tenantId: string) => number;
};

export type Actor = { userId: string };

/**
 * 주문 API 진입점. 도메인 함수는 `authorizedActions`로만 호출한다. 요청의 `tenantId`는 호출자가
 * 활성 멤버로 속한 테넌트일 때만 주체의 테넌트가 되고, 그 뒤 도메인 함수에는 주체의 값만 전달된다.
 */
export function createOrderApi(deps: OrderApiDeps) {
  /**
   * 모든 공개 메서드는 이 래퍼를 통해서만 만든다.
   * 권한 검사(활성 membership)가 업무 로직 호출보다 항상 먼저 실행된다.
   */
  function guarded<Request extends { tenantId: string }, Result>(
    run: (principal: UserPrincipal, request: Omit<Request, "tenantId">) => Result,
  ) {
    return (actor: Actor, request: Request): Result => {
      const { role } = authorizeTenantAccess(
        { memberships: deps.memberships },
        { userId: actor.userId, tenantId: request.tenantId },
      );
      const { tenantId, ...rest } = request;
      return run({ kind: "USER", userId: actor.userId, tenantId, role }, rest);
    };
  }

  return {
    listOrders: guarded<Parameters<typeof listOrders>[1], ReturnType<typeof listOrders>>(
      (principal, request) => authorizedActions.listOrders({ orders: deps.orders }, principal, request),
    ),

    getOrder: guarded<{ tenantId: string; orderId: string }, ReturnType<typeof toOrderDetail>>(
      (principal, request) => authorizedActions.getOrder({ orders: deps.orders }, principal, request),
    ),

    createOrder: guarded((principal, request: Omit<CreateOrderRequest, "tenantId">) =>
      toOrderDetail(
        authorizedActions.createOrderService(
          { orders: deps.orders, idempotency: deps.idempotency },
          principal,
          request,
        ),
      ),
    ),

    confirmOrder: guarded((principal, request: Omit<ConfirmOrderRequest, "tenantId">) =>
      toOrderDetail(
        authorizedActions.confirmOrderService(
          {
            orders: deps.orders,
            idempotency: deps.idempotency,
            issueDisplayNumber: deps.issueDisplayNumber,
          },
          principal,
          request,
        ),
      ),
    ),
  };
}
