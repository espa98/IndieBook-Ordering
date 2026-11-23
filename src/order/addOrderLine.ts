import { AppError } from "../errors/AppError";
import type { Order, OrderLine } from "./createDraftOrder";

export function addOrderLine(order: Order, line: OrderLine): Order {
  if (order.status !== "DRAFT") {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "lines can only be added to a DRAFT order",
    );
  }
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new AppError("VALIDATION_ERROR", "quantity must be an integer >= 1");
  }
  if (
    typeof line.unitPriceKrw !== "string" ||
    !/^(0|[1-9]\d*)$/.test(line.unitPriceKrw)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "unitPriceKrw must be a decimal integer string",
    );
  }
  return { ...order, lines: [...order.lines, line] };
}
