import type { Order, OrderLine } from "./createDraftOrder";

export function addOrderLine(order: Order, line: OrderLine): Order {
  if (order.status !== "DRAFT") {
    throw new Error("lines can only be added to a DRAFT order");
  }
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new Error("quantity must be an integer >= 1");
  }
  if (
    typeof line.unitPriceKrw !== "string" ||
    !/^(0|[1-9]\d*)$/.test(line.unitPriceKrw)
  ) {
    throw new Error("unitPriceKrw must be a decimal integer string");
  }
  return { ...order, lines: [...order.lines, line] };
}
