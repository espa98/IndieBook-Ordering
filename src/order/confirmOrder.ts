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
  if (options?.expectedVersion === undefined) {
    throw new Error("expectedVersion is required");
  }
  if (typeof options.issueDisplayNumber !== "function") {
    throw new Error("issueDisplayNumber is required");
  }
  if (order.status !== "DRAFT") {
    throw new Error("only a DRAFT order can be confirmed");
  }
  if (order.lines.length === 0) {
    throw new Error("order must have at least one line to confirm");
  }
  if (options.expectedVersion !== order.version) {
    throw new Error("VERSION_CONFLICT");
  }
  return {
    ...order,
    status: "CONFIRMED",
    version: order.version + 1,
    totalKrw: sumLineTotals(order.lines),
    displayNumber: options.issueDisplayNumber(order.tenantId),
  };
}
