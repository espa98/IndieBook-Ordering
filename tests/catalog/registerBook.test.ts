import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { registerBook } from "../../src/catalog/registerBook";
import { catalogScene } from "../helpers/catalogFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("registerBook: 도서 등록 (ST-B01 YES24 선택, ST-B02 수기 등록)", () => {
  it("ISBN 없는 도서를 사유와 함께 수기 등록하면 MANUAL 출처로 ACTIVE 도서가 만들어진다", () => {
    const { deps, books, manualRequest } = catalogScene();

    const book = registerBook(deps, manualRequest());

    expect(book).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      title: "책방의 오후",
      authors: ["김독립"],
      listPriceKrw: "15000",
      source: "MANUAL",
      manualReason: "YES24에 없는 독립출판물",
      status: "ACTIVE",
      version: 1,
      createdBy: "staff-1",
      createdAt: "2026-03-04T06:30:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(books).toEqual([book]);
  });

  it("YES24 결과를 선택해 등록하면 출처·외부 ID·조회 시각이 기록되고 ISBN은 숫자만으로 정규화된다", () => {
    const { deps, yes24Request } = catalogScene();

    const book = registerBook(deps, yes24Request());

    expect(book).toMatchObject({
      source: "YES24",
      externalId: "Y24-998877",
      fetchedAt: "2026-03-04T06:20:00.000Z",
      isbn: "9788960901234",
      status: "ACTIVE",
    });
    expect(book.manualReason).toBeUndefined();
  });

  const codeOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return (error as AppError).code;
    }
  };

  it("제목·판매가·ISBN 형식·출처별 필수값(수기=사유, YES24=외부 ID·조회 시각)이 틀리면 VALIDATION_ERROR 400이고 저장되지 않는다", () => {
    const { deps, books, manualRequest, yes24Request } = catalogScene();

    for (const bad of [
      manualRequest({ title: " " }),
      manualRequest({ listPriceKrw: "0" }),
      manualRequest({ listPriceKrw: "15,000" }),
      manualRequest({ isbn: "12345" }),
      manualRequest({ isbn: "978-89-6090-123-X" }),
      manualRequest({ reason: "" }),
      manualRequest({ registeredBy: "" }),
      manualRequest({ registeredAt: "2999-01-01T00:00:00.000Z" }),
      manualRequest({ authors: [""] }),
      manualRequest({ source: "NAVER" as never }),
      yes24Request({ externalId: "" }),
      yes24Request({ fetchedAt: "not-a-date" }),
      yes24Request({ fetchedAt: "2999-01-01T00:00:00.000Z" }),
    ]) {
      expect(codeOf(() => registerBook(deps, bad)), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect(books).toEqual([]);
    expect(codeOf(() => registerBook(deps, manualRequest({ isbn: "8960901237" })))).toBeUndefined(); // ISBN-10
  });

  it("같은 ISBN의 도서가 이미 있으면 중복 후보로 거부하고(BUSINESS_INVARIANT 422), 후보를 확인했다고 표시해야만 별도 도서로 등록한다. 다른 테넌트의 같은 ISBN은 무관하다", () => {
    const { deps, books, yes24Request } = catalogScene();
    const first = registerBook(deps, yes24Request());

    let thrown: unknown;
    try {
      registerBook(deps, yes24Request({ isbn: "9788960901234", externalId: "Y24-2" }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).detail).toContain(first.id);
    expect(books).toHaveLength(1);

    // 잘못된 후보 ID로는 통과할 수 없다
    expect(
      codeOf(() => registerBook(deps, yes24Request({ externalId: "Y24-3", acknowledgeDuplicateOf: "other-id" }))),
    ).toBe("BUSINESS_INVARIANT");
    const second = registerBook(deps, yes24Request({ externalId: "Y24-4", acknowledgeDuplicateOf: first.id }));
    expect(second.id).not.toBe(first.id); // 자동 병합하지 않는다
    expect(books).toHaveLength(2);

    expect(codeOf(() => registerBook(deps, yes24Request({ tenantId: "tenant-b", externalId: "Y24-5" })))).toBeUndefined();
  });
});
