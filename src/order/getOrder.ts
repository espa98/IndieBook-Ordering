import { AppError } from "../errors/AppError";
import type { OrderRepository } from "./confirmOrderService";
import type { Order } from "./createDraftOrder";

export type OrderDetail = Pick<
  Order,
  | "id"
  | "status"
  | "version"
  | "createdAt"
  | "displayNumber"
  | "totalKrw"
  | "lines"
>;

/** 외부로 내보내는 주문 형태. 필드를 하나씩 골라서, 도메인 객체에 필드가 늘어도 자동으로 노출되지 않는다. */
export function toOrderDetail(order: Order): OrderDetail {
  return {
    id: order.id,
    status: order.status,
    version: order.version,
    createdAt: order.createdAt,
    displayNumber: order.displayNumber,
    totalKrw: order.totalKrw,
    lines: order.lines,
  };
}

export function getOrder(
  deps: { orders: OrderRepository },
  request: { tenantId: string; orderId: string },
): OrderDetail {
  const order = deps.orders.get(request.tenantId, request.orderId);
  if (!order) {
    throw new AppError("NOT_FOUND");
  }
  return toOrderDetail(order);
}
