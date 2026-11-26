import { AppError } from "../errors/AppError";
import type { OrderRepository } from "./confirmOrderService";
import type { Order } from "./createDraftOrder";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const ORDER_STATUSES: readonly Order["status"][] = ["DRAFT", "CONFIRMED"];

export type OrderSummary = Pick<
  Order,
  "id" | "status" | "version" | "displayNumber" | "totalKrw" | "heldAt" | "discardedAt"
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

/** 목록 커서를 (createdAt, id)로 해석한다. 형식이 틀리면 VALIDATION_ERROR. 영속화 계층이 SQL 페이지네이션에 같은 해석을 쓴다 */
export function decodeCursor(cursor: string): SortKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(cursor));
  } catch {
    throw new AppError("VALIDATION_ERROR", "invalid cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw new AppError("VALIDATION_ERROR", "invalid cursor");
  }
  return { createdAt: parsed[0], id: parsed[1] };
}

export const MAX_SEARCH_LENGTH = 60;

/** 검색어를 해석한다: 공백을 다듬고 1~60자인지 확인한다. 숫자뿐이면 표시번호·ISBN 후보, ISBN은 하이픈을 뺀 숫자열이다. */
export function parseSearch(search: unknown): { text: string; displayNumber?: number; isbn?: string } {
  if (typeof search !== "string" || search.trim() === "" || search.trim().length > MAX_SEARCH_LENGTH) {
    throw new AppError("VALIDATION_ERROR", `search must be a string of 1..${MAX_SEARCH_LENGTH} characters`);
  }
  const text = search.trim();
  const digits = text.replace(/-/g, "");
  return {
    text,
    ...(/^[0-9]{1,15}$/.test(text) ? { displayNumber: Number(text) } : {}),
    ...(/^[0-9]{10}([0-9]{3})?$|^[0-9]{9}[0-9Xx]$/.test(digits) ? { isbn: digits.toUpperCase() } : {}),
  };
}

function matchesSearch(order: Order, search: ReturnType<typeof parseSearch>): boolean {
  if (search.displayNumber !== undefined && order.displayNumber === search.displayNumber) return true;
  const needle = search.text.toLowerCase();
  return order.lines.some(
    (l) => (l.bookTitle !== undefined && l.bookTitle.toLowerCase().includes(needle)) || (search.isbn !== undefined && l.bookIsbn === search.isbn),
  );
}

export function listOrders(
  deps: { orders: OrderRepository },
  request: {
    tenantId: string;
    limit?: number;
    cursor?: string;
    status?: Order["status"];
    /** 폐기된 초안(ST-O09)도 포함한다. 기본은 제외 */
    includeDiscarded?: boolean;
    /** 표시번호(숫자면 정확히 일치)나 품목의 도서명(부분 일치)·ISBN(정확히 일치)으로 찾는다 */
    search?: string;
  },
): { items: OrderSummary[]; nextCursor?: string } {
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AppError("VALIDATION_ERROR", "limit must be an integer 1..100");
  }
  if (
    request.status !== undefined &&
    !ORDER_STATUSES.includes(request.status)
  ) {
    throw new AppError("VALIDATION_ERROR", "invalid status");
  }
  if (request.includeDiscarded !== undefined && typeof request.includeDiscarded !== "boolean") {
    throw new AppError("VALIDATION_ERROR", "includeDiscarded must be a boolean");
  }
  const search = request.search === undefined ? undefined : parseSearch(request.search);
  const sorted = deps.orders
    .list(request.tenantId)
    .filter((o) => request.includeDiscarded === true || o.discardedAt === undefined)
    .filter((o) => search === undefined || matchesSearch(o, search))
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
    ...(o.heldAt === undefined ? {} : { heldAt: o.heldAt }),
    ...(o.discardedAt === undefined ? {} : { discardedAt: o.discardedAt }),
  }));
  const last = pageOrders[pageOrders.length - 1];
  const hasMore = remaining.length > limit;
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last) : undefined,
  };
}
