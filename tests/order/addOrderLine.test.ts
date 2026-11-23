import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { confirmOrder } from "../../src/order/confirmOrder";

describe("addOrderLine", () => {
  it("초안에 품목을 추가한 새 주문을 반환하고 원본은 바꾸지 않는다", () => {
    const draft = createDraftOrder({ tenantId: "tenant-a" });

    const updated = addOrderLine(draft, {
      bookId: "book-1",
      quantity: 2,
      unitPriceKrw: "15000",
    });

    expect(updated.lines).toEqual([
      { bookId: "book-1", quantity: 2, unitPriceKrw: "15000" },
    ]);
    expect(updated.id).toBe(draft.id);
    expect(draft.lines).toEqual([]);
  });

  it("확정된 주문에는 품목을 추가할 수 없다 (가격 스냅샷 보호)", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });
    const confirmed = confirmOrder(draft, { expectedVersion: 1, issueDisplayNumber: () => 1 });

    expect(() =>
      addOrderLine(confirmed, {
        bookId: "book-2",
        quantity: 1,
        unitPriceKrw: "1000",
      }),
    ).toThrow(/DRAFT/);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "quantity가 1 이상의 정수가 아니면(%s) 거부한다",
    (quantity) => {
      const draft = createDraftOrder({ tenantId: "tenant-a" });

      expect(() =>
        addOrderLine(draft, { bookId: "book-1", quantity, unitPriceKrw: "15000" }),
      ).toThrow(/quantity/);
    },
  );

  it.each(["15000.5", "-1", "abc", "", "015", " 100", 15000 as unknown as string])(
    "unitPriceKrw가 10진 정수 문자열이 아니면(%j) 거부한다",
    (unitPriceKrw) => {
      const draft = createDraftOrder({ tenantId: "tenant-a" });

      expect(() =>
        addOrderLine(draft, { bookId: "book-1", quantity: 1, unitPriceKrw }),
      ).toThrow(/unitPriceKrw/);
    },
  );
});
