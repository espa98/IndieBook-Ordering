import { AppError } from "../errors/AppError";
import type { NewOrderLine, Order, OrderLine } from "./createDraftOrder";

const LINE_FIELDS = ["bookId", "quantity", "unitPriceKrw"];

export function addOrderLine(order: Order, line: NewOrderLine): Order {
  if (order.status !== "DRAFT") {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "lines can only be added to a DRAFT order",
    );
  }
  if (Object.keys(line).some((key) => !LINE_FIELDS.includes(key))) {
    // 클라이언트가 보낸 필드 이름은 되돌리지 않고 허용 목록만 알린다
    throw new AppError(
      "VALIDATION_ERROR",
      `line contains unknown fields (allowed: ${LINE_FIELDS.join(", ")})`,
    );
  }
  if (typeof line.bookId !== "string") {
    throw new AppError("VALIDATION_ERROR", "bookId must be a string");
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
  const stored: OrderLine = {
    lineId: crypto.randomUUID(),
    bookId: line.bookId,
    quantity: line.quantity,
    unitPriceKrw: line.unitPriceKrw,
  };
  return { ...order, lines: [...order.lines, stored] };
}
