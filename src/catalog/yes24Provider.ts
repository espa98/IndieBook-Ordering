import { normalizeSearchItems, searchUnavailable, type BookSearchProvider, type BookSearchQuery } from "./bookSearch";

export type Yes24ProviderOptions = {
  /** YES24 상품 검색 주소(환경 변수 `YES24_BOOK_SEARCH_URL`). 실제 서비스는 `https://apis.yes24.com/v1/goods/itemList` */
  url: string;
  /** 발급받은 API 키(환경 변수 `YES24_API_KEY`). `X-Api-Key` 헤더로만 보내고 로그·오류·응답에 싣지 않는다 */
  apiKey: string;
  /** 요청 제한 시간(ms) */
  timeoutMs?: number;
  /** 시험용 대체 fetch */
  fetchImpl?: typeof fetch;
};

/** 응답 본문 상한(바이트). 이보다 크면 잘못된 응답으로 본다(상품 소개·목차가 실려 한 건도 수 KB가 될 수 있다) */
const MAX_RESPONSE_BYTES = 2_000_000;

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** YES24 `publishDate`는 `YYYYMMDD`다. 우리 형식(`YYYY-MM-DD`)으로 바꾸고, 형식이 다르면 버린다 */
const publishDate = (value: unknown): string | undefined => {
  const v = typeof value === "string" ? /^(\d{4})(\d{2})(\d{2})$/.exec(value) : null;
  return v ? `${v[1]}-${v[2]}-${v[3]}` : undefined;
};

/** 가격은 소수 표기(`33000.00`)다. 정수 값만 받아들인다 */
const wholeNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);

/** 원본 항목의 ISBN-13 또는 ISBN-10이 검색한 ISBN과 같은지(하이픈 없는 대문자 숫자열끼리 비교) */
function hasIsbn(entry: unknown, isbn: string): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return [e.isbn13, e.isbn10].some((v) => typeof v === "string" && v.toUpperCase() === isbn);
}

/** YES24 항목 → `normalizeSearchItems`가 받는 형태. 검증과 정리는 그쪽이 한다 */
function toCandidate(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  const author = str(e.author);
  return {
    id: typeof e.itemId === "number" && Number.isSafeInteger(e.itemId) && e.itemId > 0 ? String(e.itemId) : undefined,
    title: e.title,
    // 저자 필드는 "저자 저/역자 공역" 같은 하나의 문자열이라 원문 그대로 한 항목으로 둔다(임의로 쪼개 왜곡하지 않는다)
    authors: author === undefined ? [] : [author],
    isbn: str(e.isbn13) ?? str(e.isbn10),
    publisher: e.publisher,
    publishedOn: publishDate(e.publishDate),
    listPriceKrw: wholeNumber(e.shopPrice),
    coverUrl: e.cover,
    detailUrl: e.link,
  };
}

/**
 * YES24 도서 검색 어댑터(서버 측, DEC-17 단일 외부 경로). 계약은 YES24 Developers(`developers.yes24.com/api-doc/goods-item-list`)와 실제 호출로 확인했다:
 * `GET {url}?query=<검색어>&category=BOOK&pageSize=<1..100>` + 헤더 `X-Api-Key` → 성공 `200 { success, data: { items: [...] } }`.
 * 검색은 자유 텍스트 `query` 하나뿐이라 ISBN·제목·저자를 구분해 찾을 수 없다. ISBN은 숫자만 넣으면 그 도서가 나오므로(실제 확인) 결과에서 ISBN이 정확히 같은 것만 남긴다.
 *
 * 결과 없음은 404 `SEARCH_001`이며 빈 목록으로 돌려준다. 그 밖의 모든 실패(접속·시간 초과·상태 코드·깨진 JSON·너무 큰 응답·`success:false`·`items` 없음, 키 오류·속도 제한 포함)는
 * `SERVICE_UNAVAILABLE`이며 키·주소·상류 본문은 오류에 싣지 않는다.
 */
export function createYes24Provider(options: Yes24ProviderOptions): BookSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    name: "YES24",
    async search(query: BookSearchQuery) {
      const url = new URL(options.url);
      url.searchParams.set("query", query.q);
      url.searchParams.set("category", "BOOK");
      url.searchParams.set("pageSize", String(query.limit));
      let body: unknown;
      let status: number;
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", "x-api-key": options.apiKey },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        status = response.status;
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_RESPONSE_BYTES) throw new Error("too large");
        const textBody = await response.text();
        if (textBody.length > MAX_RESPONSE_BYTES) throw new Error("too large");
        body = JSON.parse(textBody);
      } catch {
        throw searchUnavailable();
      }
      const envelope = body as { success?: unknown; errorCode?: unknown; data?: { items?: unknown } | null } | null;
      if (status === 404 && envelope?.errorCode === "SEARCH_001") return [];
      if (status < 200 || status >= 300 || envelope?.success !== true) throw searchUnavailable();
      const items = envelope.data?.items;
      if (!Array.isArray(items)) throw searchUnavailable();
      // ISBN 검색은 자유 텍스트 검색이라 다른 도서가 섞일 수 있다: ISBN-13 또는 ISBN-10이 정확히 같은 항목만 남긴다(거른 뒤에 limit 적용)
      const relevant = query.type === "ISBN" ? items.filter((e) => hasIsbn(e, query.q)) : items;
      return normalizeSearchItems(relevant.map(toCandidate), query.limit);
    },
  };
}
