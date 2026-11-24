import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type { Book, BookRevision, RegisterBookRequest } from "../../src/catalog/registerBook";

/** 인메모리 도서·수정 이력 저장소 */
export function catalogScene() {
  const books: Book[] = [];
  const revisions: BookRevision[] = [];
  const deps = {
    books: {
      get: (t: string, id: string) => books.find((b) => b.tenantId === t && b.id === id),
      list: (t: string) => books.filter((b) => b.tenantId === t),
      save: (b: Book) => {
        const i = books.findIndex((x) => x.tenantId === b.tenantId && x.id === b.id);
        if (i >= 0) books[i] = b;
        else books.push(b);
      },
    },
    bookRevisions: {
      list: (t: string, bookId: string) => revisions.filter((r) => r.tenantId === t && r.bookId === bookId),
      save: (r: BookRevision) => void revisions.push(r),
    },
    idempotency: createIdempotencyStore(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const manualRequest = (extra: Partial<RegisterBookRequest> = {}): RegisterBookRequest => ({
    tenantId: "tenant-a",
    source: "MANUAL",
    title: "책방의 오후",
    authors: ["김독립"],
    listPriceKrw: "15000",
    reason: "YES24에 없는 독립출판물",
    registeredBy: "staff-1",
    registeredAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: `bk-${++seq}`,
    ...extra,
  });
  const yes24Request = (extra: Partial<RegisterBookRequest> = {}): RegisterBookRequest => ({
    tenantId: "tenant-a",
    source: "YES24",
    title: "독립서점 운영기",
    authors: ["박서점"],
    isbn: "978-89-6090-123-4",
    listPriceKrw: "16800",
    externalId: "Y24-998877",
    fetchedAt: "2026-03-04T06:20:00.000Z",
    registeredBy: "staff-1",
    registeredAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: `bk-${++seq}`,
    ...extra,
  });
  return { deps, books, revisions, manualRequest, yes24Request };
}
