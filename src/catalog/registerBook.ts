import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";

/**
 * 서점별 도서 레코드 (ST-B01/B02/B03). 주문 품목은 단가를 자기 스냅샷으로 보존하므로
 * 도서를 수정해도 기존 주문은 바뀌지 않는다 (BOOK-007).
 */
export type Book = {
  id: string;
  tenantId: string;
  title: string;
  authors: string[];
  /** 숫자만 남긴 ISBN-10/13. 없을 수 있다 (독립출판물) */
  isbn?: string;
  listPriceKrw: string;
  source: "YES24" | "MANUAL";
  externalId?: string;
  fetchedAt?: string;
  manualReason?: string;
  status: "ACTIVE";
  version: number;
  createdBy: string;
  createdAt: string;
  recordedAt: string;
};

/** 도서 수정 이력 (추가 전용). 수정 전 값을 보존한다 (ST-B03). */
export type BookRevision = {
  id: string;
  tenantId: string;
  bookId: string;
  versionBefore: number;
  versionAfter: number;
  before: { title: string; authors: string[]; isbn?: string; listPriceKrw: string };
  after: { title: string; authors: string[]; isbn?: string; listPriceKrw: string };
  reason: string;
  changedBy: string;
  changedAt: string;
};

export type BookRepository = {
  get(tenantId: string, id: string): Book | undefined;
  list(tenantId: string): Book[];
  save(book: Book): void;
};

export type RegisterBookDeps = {
  books: BookRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RegisterBookRequest = {
  tenantId: string;
  source: "YES24" | "MANUAL";
  title: string;
  authors?: string[];
  isbn?: string;
  listPriceKrw: string;
  externalId?: string;
  fetchedAt?: string;
  reason?: string;
  /** 같은 ISBN의 기존 도서가 있을 때, 중복 후보를 확인했다는 표시. 자동 병합은 하지 않는다 */
  acknowledgeDuplicateOf?: string;
  registeredBy: string;
  registeredAt: string;
  idempotencyKey: string;
};

/** 하이픈·공백을 없앤 ISBN-10/13 형식만 받는다. 체크 숫자는 검증하지 않는다 */
export function normalizeIsbn(isbn: string): string {
  const digits = isbn.replace(/[-\s]/g, "");
  if (!/^(\d{13}|\d{9}[\dX])$/.test(digits)) {
    invalid("isbn", "must be a 10 or 13 digit ISBN");
  }
  return digits;
}

export function validateBookFields(request: {
  title: string;
  authors?: string[];
  isbn?: string;
  listPriceKrw: string;
}): void {
  if (!isNonEmptyString(request.title)) {
    invalid("title", "must be a non-empty string");
  }
  if (typeof request.listPriceKrw !== "string" || !/^[1-9]\d*$/.test(request.listPriceKrw)) {
    invalid("listPriceKrw", "must be a positive integer string in KRW");
  }
  if (request.authors !== undefined && (!Array.isArray(request.authors) || !request.authors.every(isNonEmptyString))) {
    invalid("authors", "must be an array of non-empty strings");
  }
  if (request.isbn !== undefined) normalizeIsbn(request.isbn);
}

export function registerBook(deps: RegisterBookDeps, request: RegisterBookRequest): Book {
  if (request.source !== "YES24" && request.source !== "MANUAL") {
    invalid("source", "must be YES24 or MANUAL");
  }
  validateBookFields(request);
  if (!isNonEmptyString(request.registeredBy)) {
    invalid("registeredBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("registeredAt", request.registeredAt, now);
  if (request.source === "YES24") {
    // 외부 결과를 선택한 도서는 출처와 조회 시각이 있어야 한다 (ST-B01)
    if (!isNonEmptyString(request.externalId)) invalid("externalId", "must be a non-empty string");
    parseUtcTimestamp("fetchedAt", String(request.fetchedAt), now);
  } else if (!isNonEmptyString(request.reason)) {
    // 수기 등록은 사유가 필요하다 (ST-B02)
    invalid("reason", "must be a non-empty string");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "catalog.register-book",
      key: request.idempotencyKey,
      payload: {
        source: request.source,
        title: request.title,
        authors: request.authors,
        isbn: request.isbn,
        listPriceKrw: request.listPriceKrw,
        externalId: request.externalId,
        fetchedAt: request.fetchedAt,
        reason: request.reason,
        registeredBy: request.registeredBy,
        registeredAt: request.registeredAt,
      },
    },
    () => {
      const isbn = request.isbn === undefined ? undefined : normalizeIsbn(request.isbn);
      // 같은 ISBN의 도서는 중복 후보다. 확인했다는 표시 없이는 등록하지 않고, 확인해도 병합하지 않는다 (BOOK-004)
      const duplicates =
        isbn === undefined
          ? []
          : deps.books.list(request.tenantId).filter((b) => b.isbn === isbn && b.status === "ACTIVE");
      if (duplicates.length > 0 && !duplicates.some((d) => d.id === request.acknowledgeDuplicateOf)) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          `duplicate ISBN candidates: ${duplicates.map((d) => d.id).join(", ")}`,
        );
      }
      const book: Book = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        title: request.title,
        authors: request.authors ?? [],
        ...(isbn === undefined ? {} : { isbn }),
        listPriceKrw: request.listPriceKrw,
        source: request.source,
        ...(request.source === "YES24"
          ? { externalId: request.externalId, fetchedAt: request.fetchedAt }
          : { manualReason: request.reason }),
        status: "ACTIVE",
        version: 1,
        createdBy: request.registeredBy,
        createdAt: request.registeredAt,
        recordedAt: now.toISOString(),
      };
      deps.books.save(book);
      return book;
    },
  );
}
