import { AppError } from "../errors/AppError";
import { invalid } from "../procurement/validation";

/**
 * 외부 도서 검색(UC-04, DEC-17): 서버가 YES24를 **단일 외부 경로**로 호출한다. 다른 외부 API로 자동 전환하지 않으며,
 * 장애·미설정이면 SERVICE_UNAVAILABLE(503)로 알리고 사용자는 수기 등록(`source: MANUAL`)으로 대체한다.
 */
export type BookSearchType = "ISBN" | "TITLE" | "AUTHOR";
export const BOOK_SEARCH_TYPES: readonly BookSearchType[] = ["ISBN", "TITLE", "AUTHOR"];
export const MAX_SEARCH_TERM_LENGTH = 60;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 20;

export type BookSearchQuery = { type: BookSearchType; q: string; limit: number };

/** 검색 결과의 한 도서. 외부 응답에서 이 필드만 남긴다 */
export type BookSearchItem = {
  /** 외부(YES24) 도서 ID — 도서 등록 시 `externalId`로 저장한다 */
  id: string;
  title: string;
  authors: string[];
  /** 하이픈 없는 ISBN-10/13 */
  isbn?: string;
  publisher?: string;
  /** YYYY-MM-DD */
  publishedOn?: string;
  /** 외부 정가 참고값(양의 정수 문자열). 서점 판매가는 직원이 따로 입력한다 */
  listPriceKrw?: string;
  coverUrl?: string;
  detailUrl?: string;
};

export type BookSearchProvider = {
  readonly name: "YES24";
  search(query: BookSearchQuery): Promise<BookSearchItem[]>;
};

/** 검색 요청(쿼리 값)을 검증한다. ISBN은 하이픈·공백을 뺀 13자리 숫자만(ISBN-10은 검색 대상에서 제외, YES24 상품 상세 조회가 ISBN13만 받는다) */
export function parseBookSearchRequest(request: { type?: unknown; q?: unknown; limit?: unknown }): BookSearchQuery {
  if (typeof request.type !== "string" || !BOOK_SEARCH_TYPES.includes(request.type as BookSearchType)) invalid("type", "must be ISBN, TITLE or AUTHOR");
  const type = request.type as BookSearchType;
  if (typeof request.q !== "string" || request.q.trim() === "" || request.q.trim().length > MAX_SEARCH_TERM_LENGTH) {
    invalid("q", `must be a string of 1..${MAX_SEARCH_TERM_LENGTH} characters`);
  }
  let q = (request.q as string).trim();
  if (type === "ISBN") {
    const digits = q.replace(/[-\s]/g, "");
    if (!/^\d{13}$/.test(digits)) invalid("q", "must be a 13 digit ISBN (ISBN-10 is not searchable)");
    q = digits;
  }
  const limit = request.limit === undefined ? DEFAULT_SEARCH_LIMIT : request.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) invalid("limit", `must be an integer 1..${MAX_SEARCH_LIMIT}`);
  return { type, q, limit: limit as number };
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t.slice(0, max);
};
const httpsUrl = (value: unknown): string | undefined => {
  const t = text(value, 500);
  if (t === undefined) return undefined;
  try {
    const url = new URL(t);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};
const calendarDate = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : undefined;
};
const positiveInt = (value: unknown): string | undefined => {
  const s = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : undefined;
  return s !== undefined && /^[1-9]\d{0,14}$/.test(s) ? s : undefined;
};

/**
 * 외부 응답은 신뢰하지 않는다. 항목마다 id·title이 있어야 하고(없으면 그 항목을 버린다), 나머지 필드는 형식이 맞을 때만 남기며
 * 알 수 없는 필드·http/javascript 주소는 제거한다. 최대 `limit`개만 돌려준다.
 */
export function normalizeSearchItems(raw: unknown, limit: number): BookSearchItem[] {
  if (!Array.isArray(raw)) return [];
  const items: BookSearchItem[] = [];
  for (const entry of raw) {
    if (items.length >= limit) break;
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = text(e.id, 64);
    const title = text(e.title, 200);
    if (id === undefined || title === undefined) continue;
    const authors = Array.isArray(e.authors) ? e.authors.map((a) => text(a, 100)).filter((a): a is string => a !== undefined).slice(0, 10) : [];
    const isbnDigits = typeof e.isbn === "string" ? e.isbn.replace(/[-\s]/g, "").toUpperCase() : undefined;
    const isbn = isbnDigits !== undefined && /^(\d{13}|\d{9}[\dX])$/.test(isbnDigits) ? isbnDigits : undefined;
    const publisher = text(e.publisher, 100);
    const publishedOn = calendarDate(e.publishedOn);
    const listPriceKrw = positiveInt(e.listPriceKrw);
    const coverUrl = httpsUrl(e.coverUrl);
    const detailUrl = httpsUrl(e.detailUrl);
    items.push({
      id,
      title,
      authors,
      ...(isbn ? { isbn } : {}),
      ...(publisher ? { publisher } : {}),
      ...(publishedOn ? { publishedOn } : {}),
      ...(listPriceKrw ? { listPriceKrw } : {}),
      ...(coverUrl ? { coverUrl } : {}),
      ...(detailUrl ? { detailUrl } : {}),
    });
  }
  return items;
}

/** 도서 검색을 지금 쓸 수 없다(미설정·접속 실패·시간 초과·오류 응답·잘못된 응답). 원인은 응답에 싣지 않는다 */
export const searchUnavailable = () => new AppError("SERVICE_UNAVAILABLE");
