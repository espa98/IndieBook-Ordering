import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { BookRepository } from "../catalog/registerBook";
import { addOrderLine } from "./addOrderLine";
import type { OrderRepository } from "./confirmOrderService";
import {
  createDraftOrder,
  type NewOrderLine,
  type Order,
} from "./createDraftOrder";

export type CreateOrderDeps = {
  orders: OrderRepository;
  /** 연결하면 모든 품목의 도서가 이 테넌트의 카탈로그에 있어야 하고 제목·ISBN·정가를 스냅샷으로 저장한다 */
  books?: Pick<BookRepository, "get">;
  idempotency: IdempotencyStore;
};

export type CreateOrderRequest = {
  tenantId: string;
  idempotencyKey: string;
  lines: NewOrderLine[];
};

export function createOrderService(
  deps: CreateOrderDeps,
  request: CreateOrderRequest,
): Order {
  if (
    !Array.isArray(request.lines) ||
    request.lines.some(
      (line) =>
        line === null || typeof line !== "object" || Array.isArray(line),
    )
  ) {
    throw new AppError("VALIDATION_ERROR", "lines must be an array of objects");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "orders.create",
      key: request.idempotencyKey,
      payload: { lines: request.lines },
    },
    () => {
      const order = request.lines.reduce(
        addOrderLine,
        createDraftOrder({ tenantId: request.tenantId }),
      );
      const books = deps.books;
      const stored =
        books === undefined
          ? order
          : {
              ...order,
              lines: order.lines.map((line) => {
                const book = books.get(request.tenantId, line.bookId);
                if (!book) {
                  // 다른 테넌트의 도서도 같은 오류라 존재 여부가 드러나지 않는다
                  throw new AppError("VALIDATION_ERROR", "a line refers to a book that is not in the catalog");
                }
                return {
                  ...line,
                  bookTitle: book.title,
                  ...(book.isbn === undefined ? {} : { bookIsbn: book.isbn }),
                  listPriceKrw: book.listPriceKrw,
                };
              }),
            };
      deps.orders.save(stored);
      return stored;
    },
  );
}
