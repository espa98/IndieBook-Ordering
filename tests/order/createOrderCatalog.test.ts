import { describe, it, expect } from "vitest";
import { registerBook } from "../../src/catalog/registerBook";
import { updateBook } from "../../src/catalog/updateBook";
import { AppError } from "../../src/errors/AppError";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createOrderService } from "../../src/order/createOrderService";
import { catalogScene } from "../helpers/catalogFixtures";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";

function orderScene() {
  const catalog = catalogScene();
  const yes24 = registerBook(catalog.deps, catalog.yes24Request()); // ISBN·정가 16,800
  const manual = registerBook(catalog.deps, catalog.manualRequest()); // ISBN 없음, 정가 15,000
  const orders = createInMemoryOrderRepository();
  const deps = { orders, books: catalog.deps.books, idempotency: createIdempotencyStore() };
  let seq = 0;
  const request = (lines: { bookId: string; quantity: number; unitPriceKrw: string }[]) => ({
    tenantId: "tenant-a",
    idempotencyKey: `co-${++seq}`,
    lines,
  });
  return { catalog, yes24, manual, orders, deps, request };
}

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
};

describe("createOrderService: 도서 검증과 시점 스냅샷 (BOOK-007, ST-B)", () => {
  it("카탈로그에 없는 도서(없는 ID·다른 테넌트의 도서)가 한 품목이라도 있으면 VALIDATION_ERROR 400이고 주문이 저장되지 않는다", () => {
    const { deps, orders, yes24, request } = orderScene();
    const line = (bookId: string) => ({ bookId, quantity: 1, unitPriceKrw: "1000" });

    expect(codeOf(() => createOrderService(deps, request([line("no-such-book")])))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => createOrderService(deps, request([line(yes24.id), line("no-such-book")])))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => createOrderService(deps, { ...request([line(yes24.id)]), tenantId: "tenant-b" }))).toBe("VALIDATION_ERROR");
    expect(orders.list("tenant-a")).toEqual([]);
    expect(orders.list("tenant-b")).toEqual([]);
    expect(codeOf(() => createOrderService(deps, request([line(yes24.id)])))).toBeUndefined();
  });

  it("주문 품목에 그 시점의 제목·ISBN·정가가 스냅샷으로 저장되고, 이후 도서를 수정해도 기존 주문은 바뀌지 않는다", () => {
    const { deps, orders, catalog, yes24, manual, request } = orderScene();

    const order = createOrderService(deps, request([
      { bookId: yes24.id, quantity: 2, unitPriceKrw: "16000" }, // 정가와 다른 판매 단가는 그대로 둔다
      { bookId: manual.id, quantity: 1, unitPriceKrw: "15000" },
    ]));

    expect(order.lines[0]).toEqual({
      lineId: expect.any(String),
      bookId: yes24.id,
      quantity: 2,
      unitPriceKrw: "16000",
      bookTitle: "독립서점 운영기",
      bookIsbn: "9788960901234",
      listPriceKrw: "16800",
    });
    expect(order.lines[1]).toEqual({
      lineId: expect.any(String),
      bookId: manual.id,
      quantity: 1,
      unitPriceKrw: "15000",
      bookTitle: "책방의 오후",
      listPriceKrw: "15000",
    }); // ISBN이 없는 도서는 bookIsbn 키가 없다

    updateBook(catalog.deps, {
      tenantId: "tenant-a",
      bookId: yes24.id,
      expectedVersion: 1,
      changes: { title: "개정판 제목", listPriceKrw: "19000" },
      reason: "개정판",
      changedBy: "staff-1",
      changedAt: "2026-03-04T06:45:00.000Z",
      idempotencyKey: "ubk-order",
    });
    expect(orders.get("tenant-a", order.id)!.lines[0]).toMatchObject({ bookTitle: "독립서점 운영기", listPriceKrw: "16800" });
  });
});
