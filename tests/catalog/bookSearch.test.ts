import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeSearchItems, parseBookSearchRequest } from "../../src/catalog/bookSearch";
import { createYes24Provider } from "../../src/catalog/yes24Provider";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";

describe("parseBookSearchRequest: 검색 요청 해석 (ISBN·제목·저자)", () => {
  it("type과 검색어를 검증한다: ISBN은 하이픈을 뺀 10·13자리, 제목·저자는 1~60자, limit은 기본 10·1~20", () => {
    expect(parseBookSearchRequest({ type: "ISBN", q: "978-89-6090-123-4" })).toEqual({ type: "ISBN", q: "9788960901234", limit: 10 });
    expect(parseBookSearchRequest({ type: "ISBN", q: " 896090123X " })).toEqual({ type: "ISBN", q: "896090123X", limit: 10 });
    expect(parseBookSearchRequest({ type: "TITLE", q: "  독립서점 운영기 ", limit: 5 })).toEqual({ type: "TITLE", q: "독립서점 운영기", limit: 5 });
    expect(parseBookSearchRequest({ type: "AUTHOR", q: "박서점" })).toEqual({ type: "AUTHOR", q: "박서점", limit: 10 });
    for (const bad of [
      { type: "ALL", q: "x" }, { type: undefined, q: "x" }, { type: "TITLE", q: "" }, { type: "TITLE", q: "   " }, { type: "TITLE", q: "가".repeat(61) },
      { type: "ISBN", q: "12345" }, { type: "ISBN", q: "abcdefghij" }, { type: "TITLE", q: 5 }, { type: "TITLE", q: "x", limit: 0 }, { type: "TITLE", q: "x", limit: 21 }, { type: "TITLE", q: "x", limit: 1.5 },
    ]) {
      expect(thrown(() => parseBookSearchRequest(bad as never)), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });
});

describe("normalizeSearchItems: 외부 응답은 신뢰하지 않는다", () => {
  it("유효한 항목만 필요한 필드로 정리하고(알 수 없는 필드·위험한 URL 제거, 가격은 양의 정수 문자열), 잘못된 항목은 버리며, limit만큼만 돌려준다", () => {
    const items = normalizeSearchItems(
      [
        { id: "Y1", title: " 독립서점 운영기 ", authors: ["박서점", " ", 7], isbn: "978-89-6090-123-4", publisher: "책방출판", publishedOn: "2025-03-01", listPriceKrw: 16800, coverUrl: "https://img.example.com/1.jpg", detailUrl: "javascript:alert(1)", secret: "no" },
        { id: "Y2", title: "가격 문자열", listPriceKrw: "15000", coverUrl: "http://insecure.example.com/x.png" },
        { id: "Y3", title: "가격 없음·0", listPriceKrw: 0, publishedOn: "2025-13-40", isbn: "not-an-isbn" },
        { id: "", title: "id 없음" },
        { id: "Y5", title: "" },
        { id: "Y6" },
        "문자열", null, 42,
        { id: "Y7", title: "일곱 번째" },
      ],
      3,
    );
    expect(items).toEqual([
      { id: "Y1", title: "독립서점 운영기", authors: ["박서점"], isbn: "9788960901234", publisher: "책방출판", publishedOn: "2025-03-01", listPriceKrw: "16800", coverUrl: "https://img.example.com/1.jpg" },
      { id: "Y2", title: "가격 문자열", authors: [], listPriceKrw: "15000" },
      { id: "Y3", title: "가격 없음·0", authors: [] },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/secret|javascript|insecure/);
    expect(normalizeSearchItems("배열 아님" as never, 10)).toEqual([]);
    expect(normalizeSearchItems([{ id: "a", title: "t".repeat(500) }], 10)[0]!.title).toHaveLength(200); // 과도하게 긴 값은 자른다
  });
});

/** 상류(도서 검색 게이트웨이) 흉내: 요청을 기록하고 시나리오별로 응답한다 */
let server: Server;
let baseUrl = "";
const seen: { url: string; authorization?: string; apiKey?: string }[] = [];
let behavior: (req: IncomingMessage) => { status: number; body?: string; delayMs?: number } = () => ({ status: 200, body: ok([]) });
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined });
    const r = behavior(req);
    setTimeout(() => {
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body ?? "");
    }, r.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/search`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** YES24 Open API(`GET /v1/goods/itemList`, developers.yes24.com) 응답 형식: 성공은 `{ success, data: { items } }` */
const ok = (items: unknown[]) => JSON.stringify({ success: true, message: "성공", errorCode: null, data: { meta: {}, items, currentPage: 1, pageSize: 20, totalCount: items.length } });
const failure = (errorCode: string) => JSON.stringify({ success: false, message: "x", data: null, errorCode });
/** 실제 호출로 확인한 항목 모양(2026-11-26): 날짜는 YYYYMMDD, 가격은 소수 표기, isbn13이 빈 문자열일 수 있다 */
const realItem = (extra: Record<string, unknown> = {}) => ({
  sortOrder: 1, itemId: 11681152, title: "Clean Code 클린 코드", author: "로버트 C. 마틴 저/박재호,이해영 공역", goodsType: "도서", publisher: "인사이트(insight)",
  isbn10: "8966260950", isbn13: "9788966260959", shopPrice: 33000.0, salePrice: 29700.0, publishDate: "20131224", itemStatus: "절판",
  cover: "https://image.yes24.com/goods/11681152/L", link: "https://www.yes24.com/product/goods/11681152", contentDetail: { bookIntroduction: "소개" }, ...extra,
});

describe("createYes24Provider: YES24 Open API 어댑터(서버 측)", () => {
  const provider = (extra: Record<string, unknown> = {}) => createYes24Provider({ url: baseUrl, apiKey: "secret-key-123", timeoutMs: 800, ...extra });
  const failureOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "OK";
    } catch (error) {
      return error instanceof AppError ? error : new Error(`NON_APP_ERROR:${(error as Error).message}`);
    }
  };

  it("검색어를 query로, 도서만(category=BOOK)·pageSize=limit으로 보내고 키는 X-Api-Key 헤더로만 보내며(Bearer 아님), 응답 항목을 우리 형식으로 바꾼다", async () => {
    behavior = () => ({ status: 200, body: ok([realItem(), { itemId: 0, title: "" }]) });
    seen.length = 0;

    const items = await provider().search({ type: "TITLE", q: "운영기 & 독립", limit: 5 });

    expect(items).toEqual([
      { id: "11681152", title: "Clean Code 클린 코드", authors: ["로버트 C. 마틴 저/박재호,이해영 공역"], isbn: "9788966260959", publisher: "인사이트(insight)", publishedOn: "2013-12-24", listPriceKrw: "33000", coverUrl: "https://image.yes24.com/goods/11681152/L", detailUrl: "https://www.yes24.com/product/goods/11681152" },
    ]);
    const url = new URL(seen[0]!.url, "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: "운영기 & 독립", category: "BOOK", pageSize: "5" }); // 검색어는 인코딩되어 전달된다
    expect(seen[0]!.apiKey).toBe("secret-key-123");
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it("ISBN 검색은 자유 텍스트 검색이라 다른 도서가 섞일 수 있어 ISBN-13 또는 ISBN-10이 정확히 같은 항목만 남기고, 제목·저자 검색은 거르지 않는다", async () => {
    const other = realItem({ itemId: 2, title: "다른 책", isbn10: "1111111111", isbn13: "9781111111111" });
    const noIsbn13 = realItem({ itemId: 3, title: "ISBN13 빈 값", isbn10: "896626095X", isbn13: "" });
    behavior = () => ({ status: 200, body: ok([other, realItem(), noIsbn13]) });

    const byIsbn13 = await provider().search({ type: "ISBN", q: "9788966260959", limit: 10 });
    const byIsbn10 = await provider().search({ type: "ISBN", q: "8966260950", limit: 10 });
    const byIsbn10WithoutIsbn13 = await provider().search({ type: "ISBN", q: "896626095X", limit: 10 });
    const byTitle = await provider().search({ type: "TITLE", q: "책", limit: 10 });

    expect(byIsbn13.map((b) => b.id)).toEqual(["11681152"]);
    expect(byIsbn10.map((b) => b.id)).toEqual(["11681152"]);
    expect(byIsbn10WithoutIsbn13.map((b) => [b.id, b.isbn])).toEqual([["3", "896626095X"]]);
    expect(byTitle.map((b) => b.id)).toEqual(["2", "11681152", "3"]);
  });

  it("결과 없음(404 SEARCH_001)은 오류가 아니라 빈 목록이다", async () => {
    behavior = () => ({ status: 404, body: failure("SEARCH_001") });

    expect(await provider().search({ type: "TITLE", q: "없는책", limit: 5 })).toEqual([]);
  });

  it("키 오류·속도 제한·상류 장애·결과 제공 불가·깨진 응답·시간 초과·접속 실패는 모두 SERVICE_UNAVAILABLE이고, 키·상류 응답·주소가 오류에 새지 않는다(다른 곳으로 자동 전환도 없다)", async () => {
    for (const [name, b] of Object.entries({
      "401 키 없음": () => ({ status: 401, body: failure("AUTH_001") }),
      "401 키 오류": () => ({ status: 401, body: failure("AUTH_002") }),
      "400 파라미터": () => ({ status: 400, body: failure("PARAM_006") }),
      "404 결과 제공 불가": () => ({ status: 404, body: failure("SEARCH_002") }),
      "429 속도 제한": () => ({ status: 429, body: "{}" }),
      "502 상류": () => ({ status: 502, body: failure("UPSTREAM_UNAVAILABLE") }),
      "504 시간 초과": () => ({ status: 504, body: failure("UPSTREAM_TIMEOUT") }),
      "500": () => ({ status: 500, body: "internal secret-key-123" }),
      "200이지만 success false": () => ({ status: 200, body: failure("X") }),
      "깨진 JSON": () => ({ status: 200, body: "{not json" }),
      "items 없음": () => ({ status: 200, body: JSON.stringify({ success: true, data: {} }) }),
      "너무 큰 응답": () => ({ status: 200, body: ok([realItem({ pad: "x".repeat(2_100_000) })]) }),
      "느린 응답": () => ({ status: 200, body: ok([]), delayMs: 2_000 }),
    })) {
      behavior = b;
      const error = await failureOf(() => provider().search({ type: "ISBN", q: "9788966260959", limit: 10 }));
      expect(error, name).toBeInstanceOf(AppError);
      expect((error as AppError).code, name).toBe("SERVICE_UNAVAILABLE");
      expect(String((error as AppError).message) + String((error as AppError).detail ?? ""), name).not.toMatch(/secret-key-123|127\.0\.0\.1|internal/);
    }
    // 접속 실패(닫힌 포트)
    const down = await failureOf(() => createYes24Provider({ url: "http://127.0.0.1:1/search", apiKey: "k", timeoutMs: 800 }).search({ type: "TITLE", q: "x", limit: 1 }));
    expect((down as AppError).code).toBe("SERVICE_UNAVAILABLE");
  });
});
