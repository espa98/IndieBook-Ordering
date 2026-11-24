import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { Book, BookRevision, RegisterBookRequest } from "../catalog/registerBook";
import type { UpdateBookRequest } from "../catalog/updateBook";
import {
  inTransaction,
  isCommandKeyConflict,
  isUuid,
  loadCommands,
  loadMembership,
  principalFor,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";

type Actor = { userId: string };

/** 호출자가 보내는 요청. 행위자 이름은 인증된 사용자에서 주입된다 */
export type RegisterBookBody = Omit<RegisterBookRequest, "registeredBy">;

export type UpdateBookBody = Omit<UpdateBookRequest, "changedBy">;

export const toBook = (b: any): Book => ({
  id: b.id,
  tenantId: b.tenant_id,
  title: b.title,
  authors: b.authors,
  ...(b.isbn === null ? {} : { isbn: b.isbn }),
  listPriceKrw: String(b.list_price_krw),
  source: b.source,
  ...(b.external_id === null ? {} : { externalId: b.external_id }),
  ...(b.fetched_at === null ? {} : { fetchedAt: b.fetched_at.toISOString() }),
  ...(b.manual_reason === null ? {} : { manualReason: b.manual_reason }),
  status: b.status,
  version: Number(b.version),
  createdBy: b.created_by,
  createdAt: b.created_at.toISOString(),
  recordedAt: b.recorded_at.toISOString(),
});

/** 도서 등록·수정을 Postgres 영속화 위에서 실행한다 (ST-B01~B03). */
export function createPgCatalogApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        throw error;
      }
    }
  };

  const loadAllBooks = async (client: PoolClient, tenantId: string): Promise<Book[]> =>
    isUuid(tenantId) ? (await client.query("select * from public.ordering_books where tenant_id = $1 order by recorded_at, id", [tenantId])).rows.map(toBook) : [];

  const registerOnce = (actor: Actor, request: RegisterBookBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      // 같은 서점의 도서 등록·수정을 직렬화한다(중복 ISBN 검사가 경쟁하지 않게)
      if (isUuid(request.tenantId)) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`books:${request.tenantId}`]);
      const books = await loadAllBooks(client, request.tenantId);
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: Book[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.registerBook(
        { books: { get: (_t2, id) => books.find((b) => b.id === id), list: () => books, save: (b) => void saved.push(b) }, idempotency },
        principal,
        rest,
      );
      for (const b of saved) {
        await client.query(
          "insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, external_id, fetched_at, manual_reason, status, version, created_by, created_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
          [b.id, b.tenantId, b.title, b.authors, b.isbn ?? null, b.listPriceKrw, b.source, b.externalId ?? null, b.fetchedAt ?? null, b.manualReason ?? null, b.status, b.version, b.createdBy, b.createdAt, b.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const updateOnce = (actor: Actor, request: UpdateBookBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      if (isUuid(request.tenantId)) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`books:${request.tenantId}`]);
      const books = await loadAllBooks(client, request.tenantId);
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const savedBooks: Book[] = [];
      const savedRevisions: BookRevision[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.updateBook(
        {
          books: { get: (_t2, id) => books.find((b) => b.id === id), list: () => books, save: (b) => void savedBooks.push(b) },
          bookRevisions: { save: (r) => void savedRevisions.push(r) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const b of savedBooks) {
        await client.query("update public.ordering_books set title = $3, authors = $4, isbn = $5, list_price_krw = $6, version = $7 where tenant_id = $1 and id = $2", [b.tenantId, b.id, b.title, b.authors, b.isbn ?? null, b.listPriceKrw, b.version]);
      }
      for (const r of savedRevisions) {
        await client.query(
          "insert into public.ordering_book_revisions (id, tenant_id, book_id, version_before, version_after, before, after, reason, changed_by, changed_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [r.id, r.tenantId, r.bookId, r.versionBefore, r.versionAfter, JSON.stringify(r.before), JSON.stringify(r.after), r.reason, r.changedBy, r.changedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  return {
    updateBook: (actor: Actor, request: UpdateBookBody) => withRetry(() => updateOnce(actor, request)),
    registerBook: (actor: Actor, request: RegisterBookBody) => withRetry(() => registerOnce(actor, request)),
  };
}
