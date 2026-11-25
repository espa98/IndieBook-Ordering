import { describe, it, expect } from "vitest";
import { registerBook } from "../../src/catalog/registerBook";
import { updateBook } from "../../src/catalog/updateBook";
import type { UpdateBookRequest } from "../../src/catalog/updateBook";
import { AppError } from "../../src/errors/AppError";
import { world } from "../helpers/procurementWorld";
import { catalogScene } from "../helpers/catalogFixtures";

function updateScene() {
  const s = catalogScene();
  const book = registerBook(s.deps, s.yes24Request());
  let seq = 0;
  const updateRequest = (extra: Partial<UpdateBookRequest> = {}): UpdateBookRequest => ({
    tenantId: "tenant-a",
    bookId: book.id,
    expectedVersion: book.version,
    changes: { listPriceKrw: "17500" },
    reason: "출판사 정가 인상",
    changedBy: "staff-1",
    changedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: `ubk-${++seq}`,
    ...extra,
  });
  return { ...s, book, updateRequest };
}

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
};

describe("updateBook: 도서 정보 수정 (ST-B03, BOOK-003/007)", () => {
  it("수정하면 version+1이 되고 수정 전 값이 이력에 보존되며, 출처·외부 ID는 바뀌지 않고 이미 만든 주문의 단가는 그대로다", () => {
    const { deps, book, revisions, updateRequest } = updateScene();
    const w = world();
    const order = w.addOrder([{ bookId: book.id, quantity: 1, unitPriceKrw: book.listPriceKrw }]);

    const updated = updateBook(deps, updateRequest());

    expect(updated).toMatchObject({
      id: book.id,
      version: 2,
      listPriceKrw: "17500",
      title: book.title,
      source: "YES24",
      externalId: "Y24-998877",
    });
    expect(deps.books.get("tenant-a", book.id)).toEqual(updated);
    expect(revisions).toEqual([
      {
        id: expect.any(String),
        tenantId: "tenant-a",
        bookId: book.id,
        versionBefore: 1,
        versionAfter: 2,
        before: { title: book.title, authors: book.authors, isbn: book.isbn, listPriceKrw: "16800" },
        after: { title: book.title, authors: book.authors, isbn: book.isbn, listPriceKrw: "17500" },
        reason: "출판사 정가 인상",
        changedBy: "staff-1",
        changedAt: "2026-03-04T06:45:00.000Z",
      },
    ]);
    expect(w.deps.orders.get("tenant-a", order.id)!.lines[0]!.unitPriceKrw).toBe("16800");
  });

  it("version이 다르면 VERSION_CONFLICT 409, 없는 도서·다른 테넌트는 NOT_FOUND, 변경이 없거나 형식이 틀리면 VALIDATION_ERROR 400이며 이력이 남지 않는다", () => {
    const { deps, revisions, updateRequest, book } = updateScene();

    expect(codeOf(() => updateBook(deps, updateRequest({ expectedVersion: 9 })))).toBe("VERSION_CONFLICT");
    expect(codeOf(() => updateBook(deps, updateRequest({ bookId: "no-such" })))).toBe("NOT_FOUND");
    expect(codeOf(() => updateBook(deps, updateRequest({ tenantId: "tenant-b" })))).toBe("NOT_FOUND");
    for (const bad of [
      { changes: {} },
      { changes: { title: " " } },
      { changes: { listPriceKrw: "-5" } },
      { changes: { isbn: "abc" } },
      { reason: "" },
      { changedBy: "" },
      { expectedVersion: 0 },
    ]) {
      expect(codeOf(() => updateBook(deps, updateRequest(bad as never))), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect(revisions).toEqual([]);
    expect(deps.books.get("tenant-a", book.id)!.version).toBe(1);
  });

  it("changes가 객체가 아니면(문자열·숫자·불리언·배열) 내부 오류(TypeError)가 아니라 VALIDATION_ERROR 400이다", () => {
    const { deps, revisions, updateRequest, book } = updateScene();

    for (const bad of ["title", 5, true, ["title"]]) {
      expect(() => updateBook(deps, updateRequest({ changes: bad as never })), JSON.stringify(bad)).toThrow(AppError);
      expect(codeOf(() => updateBook(deps, updateRequest({ changes: bad as never }))), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect(revisions).toEqual([]);
    expect(deps.books.get("tenant-a", book.id)!.version).toBe(1);
  });

  it("ISBN을 다른 도서와 같게 바꾸면 중복 후보로 거부하고 확인 표시가 있으면 허용하며, 자기 자신의 ISBN을 그대로 두는 수정은 중복이 아니다", () => {
    const { deps, book, manualRequest, updateRequest } = updateScene();
    const other = registerBook(deps, manualRequest({ isbn: "9780000000002" }));

    expect(codeOf(() => updateBook(deps, updateRequest({ bookId: other.id, expectedVersion: 1, changes: { isbn: book.isbn! } })))).toBe(
      "BUSINESS_INVARIANT",
    );
    expect(
      codeOf(() =>
        updateBook(deps, updateRequest({ bookId: other.id, expectedVersion: 1, changes: { isbn: book.isbn! }, acknowledgeDuplicateOf: book.id })),
      ),
    ).toBeUndefined();
    expect(codeOf(() => updateBook(deps, updateRequest({ changes: { isbn: book.isbn!, title: "개정판" } })))).toBeUndefined();
  });
});
