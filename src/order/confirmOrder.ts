import { AppError } from "../errors/AppError";
import type { Order, OrderLine } from "./createDraftOrder";

function sumLineTotals(lines: OrderLine[]): string {
  return lines
    .reduce(
      (sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitPriceKrw),
      0n,
    )
    .toString();
}

export function confirmOrder(
  order: Order,
  options: {
    expectedVersion: number;
    issueDisplayNumber: (tenantId: string) => number;
  },
): Order {
  if (
    !Number.isInteger(options?.expectedVersion) ||
    options.expectedVersion < 1
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "expectedVersion must be an integer >= 1",
    );
  }
  if (typeof options.issueDisplayNumber !== "function") {
    throw new Error("issueDisplayNumber is required");
  }
  if (order.status !== "DRAFT") {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "only a DRAFT order can be confirmed",
    );
  }
  if (order.lines.length === 0) {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "order must have at least one line to confirm",
    );
  }
  if (options.expectedVersion !== order.version) {
    throw new AppError("VERSION_CONFLICT");
  }
  return {
    ...order,
    status: "CONFIRMED",
    version: order.version + 1,
    totalKrw: sumLineTotals(order.lines),
    displayNumber: options.issueDisplayNumber(order.tenantId),
  };
}
