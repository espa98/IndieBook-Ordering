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

export function getOrder(
  deps: { orders: OrderRepository },
  request: { tenantId: string; orderId: string },
): OrderDetail {
  const order = deps.orders.get(request.tenantId, request.orderId);
  if (!order) {
    throw new AppError("NOT_FOUND");
  }
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
