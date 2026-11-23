import type { OrderRepository } from "./confirmOrderService";
import type { Order } from "./createDraftOrder";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ORDER_STATUSES: readonly Order["status"][] = ["DRAFT", "CONFIRMED"];

export type OrderSummary = Pick<
  Order,
  "id" | "status" | "version" | "displayNumber" | "totalKrw"
>;

type SortKey = { createdAt: string; id: string };

/** (createdAt, id) 내림차순 비교: 앞에 와야 하면 음수. */
function compareNewestFirst(a: SortKey, b: SortKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

function encodeCursor(key: SortKey): string {
  return btoa(JSON.stringify([key.createdAt, key.id]));
}

function decodeCursor(cursor: string): SortKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(cursor));
  } catch {
    throw new Error("VALIDATION_ERROR: invalid cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw new Error("VALIDATION_ERROR: invalid cursor");
  }
  return { createdAt: parsed[0], id: parsed[1] };
}

export function listOrders(
  deps: { orders: OrderRepository },
  request: {
    tenantId: string;
    limit?: number;
    cursor?: string;
    status?: Order["status"];
  },
): { items: OrderSummary[]; nextCursor?: string } {
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error("VALIDATION_ERROR: limit must be an integer 1..100");
  }
  if (
    request.status !== undefined &&
    !ORDER_STATUSES.includes(request.status)
  ) {
    throw new Error("VALIDATION_ERROR: invalid status");
  }
  const sorted = deps.orders
    .list(request.tenantId)
    .filter((o) => request.status === undefined || o.status === request.status)
    .sort(compareNewestFirst);
  const after =
    request.cursor === undefined ? undefined : decodeCursor(request.cursor);
  const remaining = after
    ? sorted.filter((o) => compareNewestFirst(o, after) > 0)
    : sorted;

  const pageOrders = remaining.slice(0, limit);
  const items = pageOrders.map((o) => ({
    id: o.id,
    status: o.status,
    version: o.version,
    displayNumber: o.displayNumber,
    totalKrw: o.totalKrw,
  }));
  const last = pageOrders[pageOrders.length - 1];
  const hasMore = remaining.length > limit;
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last) : undefined,
  };
}
