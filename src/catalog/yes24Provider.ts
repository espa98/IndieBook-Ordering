import { normalizeSearchItems, searchUnavailable, type BookSearchProvider, type BookSearchQuery } from "./bookSearch";

export type Yes24ProviderOptions = {
  /** YES24 도서 검색 게이트웨이 주소(환경 변수 `YES24_BOOK_SEARCH_URL`). 아래 계약을 구현해야 한다 */
  url: string;
  /** 접근 키(환경 변수 `YES24_API_KEY`). `Authorization: Bearer`로만 보내고 로그·오류·응답에 싣지 않는다 */
  apiKey: string;
  /** 요청 제한 시간(ms) */
  timeoutMs?: number;
  /** 시험용 대체 fetch */
  fetchImpl?: typeof fetch;
};

/** 응답 본문 상한(바이트). 이보다 크면 잘못된 응답으로 본다 */
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * YES24 도서 검색 어댑터(서버 측, DEC-17 단일 외부 경로).
 *
 * **상류 계약(YES24 쪽이 구현해야 하는 형태 — 실제 YES24 API의 형식·이용 권한은 아직 확인되지 않았다):**
 * `GET {url}?type=ISBN|TITLE|AUTHOR&q=<검색어>&limit=<1..20>` + `Authorization: Bearer <키>` →
 * `200 { "items": [ { "id", "title", "authors"?, "isbn"?, "publisher"?, "publishedOn"?, "listPriceKrw"?, "coverUrl"?, "detailUrl"? } ] }`.
 * 실제 YES24 API가 이 형태와 다르면 이 파일의 호출·매핑 한 곳만 바꾸면 된다(검증·정리·오류 처리·엔드포인트는 그대로).
 *
 * 모든 실패(접속·시간 초과·상태 코드·깨진 JSON·너무 큰 응답·`items` 없음)는 `SERVICE_UNAVAILABLE`이며 키·주소·상류 본문은 오류에 싣지 않는다.
 */
export function createYes24Provider(options: Yes24ProviderOptions): BookSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    name: "YES24",
    async search(query: BookSearchQuery) {
      const url = new URL(options.url);
      url.searchParams.set("type", query.type);
      url.searchParams.set("q", query.q);
      url.searchParams.set("limit", String(query.limit));
      let body: unknown;
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        if (!response.ok) throw new Error("status");
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_RESPONSE_BYTES) throw new Error("too large");
        const textBody = await response.text();
        if (textBody.length > MAX_RESPONSE_BYTES) throw new Error("too large");
        body = JSON.parse(textBody);
      } catch {
        throw searchUnavailable();
      }
      const items = (body as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) throw searchUnavailable();
      return normalizeSearchItems(items, query.limit);
    },
  };
}
