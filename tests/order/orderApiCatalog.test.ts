import { describe, it, expect } from "vitest";
import { registerBook } from "../../src/catalog/registerBook";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { handle } from "../../src/http/handle";
import { createOrderApi } from "../../src/order/orderApi";
import { catalogScene } from "../helpers/catalogFixtures";
import { createInMemoryMembershipRepository } from "../helpers/inMemoryMembershipRepository";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";

describe("주문 API: 카탈로그 도서만 주문할 수 있다 (BOOK-007)", () => {
  function apiScene() {
    const catalog = catalogScene();
    const book = registerBook(catalog.deps, catalog.yes24Request());
    const orders = createInMemoryOrderRepository();
    const api = createOrderApi({
      orders,
      books: catalog.deps.books,
      memberships: createInMemoryMembershipRepository([
        { userId: "owner-a", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
      ]),
      idempotency: createIdempotencyStore(),
      issueDisplayNumber: () => 1,
    });
    return { api, orders, book };
  }
  const owner = { userId: "owner-a" };

  it("없는 도서가 있는 주문은 400이고 저장되지 않으며, 카탈로그 도서의 주문은 201로 만들어지고 응답에 스냅샷이 담긴다", () => {
    const { api, orders, book } = apiScene();

    const bad = handle(
      () => api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k-1", lines: [{ bookId: "ghost", quantity: 1, unitPriceKrw: "1000" }] }),
      { successStatus: 201 },
    );
    expect(bad.status).toBe(400);
    expect(orders.list("tenant-a")).toEqual([]);

    const ok = handle(
      () => api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k-2", lines: [{ bookId: book.id, quantity: 1, unitPriceKrw: "16800" }] }),
      { successStatus: 201 },
    );
    expect(ok.status).toBe(201);
    expect((ok.body as { data: { lines: unknown[] } }).data.lines[0]).toMatchObject({
      bookId: book.id,
      bookTitle: "독립서점 운영기",
      bookIsbn: "9788960901234",
      listPriceKrw: "16800",
    });
  });
});
