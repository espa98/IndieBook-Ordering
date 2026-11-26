import { normalizeSearchItems, searchUnavailable, type BookSearchProvider, type BookSearchQuery } from "./bookSearch";

export type Yes24ProviderOptions = {
  /**
   * YES24 상품 검색 주소(환경 변수 `YES24_BOOK_SEARCH_URL`). 실제 서비스는 `https://apis.yes24.com/v1/goods/itemList`.
   * ISBN 검색에 쓰는 상품 상세 조회는 같은 위치의 `itemDetail`(`https://apis.yes24.com/v1/goods/itemDetail`)이다.
   */
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

/** 원본 항목의 ISBN-13이 검색한 ISBN-13과 같은지 */
function hasIsbn13(entry: unknown, isbn13: string): boolean {
  return entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).isbn13 === isbn13;
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
 * YES24 도서 검색 어댑터(서버 측, DEC-17 단일 외부 경로). 계약은 YES24 Developers(`developers.yes24.com/api-doc/goods-item-list`, `…/goods-item-detail`)와 실제 호출로 확인했다. 인증은 모두 헤더 `X-Api-Key`이고 성공은 `200 { success, data: { items: [...] } }`다.
 * - 제목·저자: `GET {url}?query=<검색어>&category=BOOK&pageSize=<1..100>`(상품 검색 `itemList`). 자유 텍스트 `query` 하나뿐이라 제목과 저자를 구분해 찾을 수 없다. 결과 없음은 404 `SEARCH_001`.
 * - ISBN: `GET {url의 itemDetail}?searchType=ISBN13&query=<ISBN-13>`(상품 상세 조회). 그 ISBN 한 건을 돌려주며 ISBN-10은 지원하지 않는다(검색 요청 검증이 13자리만 받는다). 상품 없음은 404 `GOODS_001`·`GOODS_002`.
 *   응답의 ISBN-13이 검색한 값과 다르면 버린다.
 *
 * 결과 없음은 빈 목록이다. 그 밖의 모든 실패(접속·시간 초과·상태 코드·깨진 JSON·너무 큰 응답·`success:false`·`items` 없음, 키 오류·속도 제한 포함)는
 * `SERVICE_UNAVAILABLE`이며 키·주소·상류 본문은 오류에 싣지 않는다.
 */
export function createYes24Provider(options: Yes24ProviderOptions): BookSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    name: "YES24",
    async search(query: BookSearchQuery) {
      // ISBN은 상품 상세 조회(ISBN13 한 건), 제목·저자는 상품 검색(자유 텍스트)
      const url = query.type === "ISBN" ? new URL("itemDetail", options.url) : new URL(options.url);
      if (query.type === "ISBN") {
        url.searchParams.set("searchType", "ISBN13");
        url.searchParams.set("query", query.q);
      } else {
        url.searchParams.set("query", query.q);
        url.searchParams.set("category", "BOOK");
        url.searchParams.set("pageSize", String(query.limit));
      }
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
      // 결과 없음: 검색(itemList)은 SEARCH_001, 상세 조회(itemDetail)는 GOODS_001·GOODS_002(404). 엔드포인트에 맞지 않는 코드는 장애로 본다
      const notFound = query.type === "ISBN" ? ["GOODS_001", "GOODS_002"] : ["SEARCH_001"];
      if (status === 404 && typeof envelope?.errorCode === "string" && notFound.includes(envelope.errorCode)) return [];
      if (status < 200 || status >= 300 || envelope?.success !== true) throw searchUnavailable();
      const items = envelope.data?.items;
      if (!Array.isArray(items)) throw searchUnavailable();
      // ISBN 검색: 상세 조회가 그 ISBN-13 한 건을 돌려주지만, 다른 ISBN의 항목이 오면 버린다(잘못된 도서 등록 방지)
      const relevant = query.type === "ISBN" ? items.filter((e) => hasIsbn13(e, query.q)) : items;
      return normalizeSearchItems(relevant.map(toCandidate), query.limit);
    },
  };
}
