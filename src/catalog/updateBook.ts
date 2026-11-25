import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import {
  normalizeIsbn,
  validateBookFields,
  type Book,
  type BookRepository,
  type BookRevision,
} from "./registerBook";

export type UpdateBookDeps = {
  books: BookRepository;
  bookRevisions: { save(revision: BookRevision): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type BookChanges = {
  title?: string;
  authors?: string[];
  isbn?: string;
  listPriceKrw?: string;
};

export type UpdateBookRequest = {
  tenantId: string;
  bookId: string;
  expectedVersion: number;
  changes: BookChanges;
  reason: string;
  acknowledgeDuplicateOf?: string;
  changedBy: string;
  changedAt: string;
  idempotencyKey: string;
};

const snapshot = (b: Book) => ({
  title: b.title,
  authors: b.authors,
  ...(b.isbn === undefined ? {} : { isbn: b.isbn }),
  listPriceKrw: b.listPriceKrw,
});

/**
 * 도서의 제목·저자·ISBN·판매가를 수정한다 (ST-B03). 수정 전 값은 이력에 보존하고, 출처 정보는 바꾸지 않는다.
 * 주문 품목은 자기 단가를 따로 가지므로 기존 주문은 영향을 받지 않는다. 자동 병합은 하지 않는다.
 */
export function updateBook(deps: UpdateBookDeps, request: UpdateBookRequest): Book {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    invalid("expectedVersion", "must be an integer >= 1");
  }
  const changes = request.changes ?? {};
  if (typeof changes !== "object" || Array.isArray(changes)) {
    invalid("changes", "must be an object");
  }
  if (!["title", "authors", "isbn", "listPriceKrw"].some((k) => k in changes)) {
    invalid("changes", "at least one field must change");
  }
  for (const field of ["reason", "changedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("changedAt", request.changedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "catalog.update-book",
      key: request.idempotencyKey,
      payload: {
        bookId: request.bookId,
        expectedVersion: request.expectedVersion,
        changes,
        reason: request.reason,
        acknowledgeDuplicateOf: request.acknowledgeDuplicateOf,
        changedBy: request.changedBy,
        changedAt: request.changedAt,
      },
    },
    () => {
      const book = deps.books.get(request.tenantId, request.bookId);
      if (!book) {
        throw new AppError("NOT_FOUND");
      }
      if (book.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      const merged = {
        title: changes.title ?? book.title,
        authors: changes.authors ?? book.authors,
        isbn: changes.isbn ?? book.isbn,
        listPriceKrw: changes.listPriceKrw ?? book.listPriceKrw,
      };
      validateBookFields(merged);
      const isbn = merged.isbn === undefined ? undefined : normalizeIsbn(merged.isbn);
      if (isbn !== undefined && isbn !== book.isbn) {
        const duplicates = deps.books
          .list(request.tenantId)
          .filter((b) => b.id !== book.id && b.isbn === isbn && b.status === "ACTIVE");
        if (duplicates.length > 0 && !duplicates.some((d) => d.id === request.acknowledgeDuplicateOf)) {
          throw new AppError(
            "BUSINESS_INVARIANT",
            `duplicate ISBN candidates: ${duplicates.map((d) => d.id).join(", ")}`,
          );
        }
      }
      const updated: Book = {
        ...book,
        title: merged.title,
        authors: merged.authors,
        ...(isbn === undefined ? {} : { isbn }),
        listPriceKrw: merged.listPriceKrw,
        version: book.version + 1,
      };
      deps.books.save(updated);
      deps.bookRevisions.save({
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        bookId: book.id,
        versionBefore: book.version,
        versionAfter: updated.version,
        before: snapshot(book),
        after: snapshot(updated),
        reason: request.reason,
        changedBy: request.changedBy,
        changedAt: request.changedAt,
      });
      return updated;
    },
  );
}
