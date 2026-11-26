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
const seen: { url: string; authorization?: string }[] = [];
let behavior: (req: IncomingMessage) => { status: number; body?: string; delayMs?: number } = () => ({ status: 200, body: JSON.stringify({ items: [] }) });
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
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

describe("createYes24Provider: 서버 측 어댑터", () => {
  const provider = (extra: Record<string, unknown> = {}) => createYes24Provider({ url: baseUrl, apiKey: "secret-key-123", timeoutMs: 800, ...extra });
  const unavailable = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "OK";
    } catch (error) {
      return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
    }
  };

  it("검색어·type·limit을 쿼리로, 키를 Bearer 헤더로 보내고, 응답 항목을 정리해 돌려준다", async () => {
    behavior = () => ({ status: 200, body: JSON.stringify({ items: [{ id: "Y1", title: "독립서점 운영기", isbn: "9788960901234", listPriceKrw: 16800 }, { id: "", title: "버려질 항목" }] }) });
    seen.length = 0;
    const items = await provider().search({ type: "TITLE", q: "운영기 & 독립", limit: 5 });
    expect(items).toEqual([{ id: "Y1", title: "독립서점 운영기", authors: [], isbn: "9788960901234", listPriceKrw: "16800" }]);
    const url = new URL(seen[0]!.url, "http://x");
    expect(url.pathname).toBe("/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ type: "TITLE", q: "운영기 & 독립", limit: "5" }); // 검색어는 인코딩되어 전달된다
    expect(seen[0]!.authorization).toBe("Bearer secret-key-123");
  });

  it("상류의 오류·잘못된 응답·시간 초과·접속 실패는 모두 SERVICE_UNAVAILABLE이고, 키·상류 응답·주소가 오류에 새지 않는다(다른 곳으로 자동 전환도 없다)", async () => {
    for (const [name, b] of Object.entries({
      "500": () => ({ status: 500, body: "internal secret-key-123" }),
      "401": () => ({ status: 401, body: "{}" }),
      "깨진 JSON": () => ({ status: 200, body: "{not json" }),
      "items 없음": () => ({ status: 200, body: JSON.stringify({ result: [] }) }),
      "너무 큰 응답": () => ({ status: 200, body: JSON.stringify({ items: [], pad: "x".repeat(2_000_000) }) }),
      "느린 응답": () => ({ status: 200, body: JSON.stringify({ items: [] }), delayMs: 2_000 }),
    })) {
      behavior = b;
      const error = await (async () => {
        try {
          await provider().search({ type: "ISBN", q: "9788960901234", limit: 10 });
        } catch (e) {
          return e;
        }
      })();
      expect(error, name).toBeInstanceOf(AppError);
      expect((error as AppError).code, name).toBe("SERVICE_UNAVAILABLE");
      expect(String((error as AppError).message) + String((error as AppError).detail ?? ""), name).not.toMatch(/secret-key-123|127\.0\.0\.1|internal/);
    }
    // 접속 실패(닫힌 포트)
    expect(await unavailable(() => createYes24Provider({ url: "http://127.0.0.1:1/search", apiKey: "k", timeoutMs: 800 }).search({ type: "TITLE", q: "x", limit: 1 }))).toBe("SERVICE_UNAVAILABLE");
  });
});
