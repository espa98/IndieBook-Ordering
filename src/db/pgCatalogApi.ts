import { AppError } from "../errors/AppError";
import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { Book, BookRevision, RegisterBookRequest } from "../catalog/registerBook";
import type { TemplateVersion } from "../catalog/messageTemplate";
import type { PublishTemplateVersionRequest } from "../catalog/publishTemplateVersion";
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

export type PublishTemplateVersionBody = Omit<PublishTemplateVersionRequest, "actorRole" | "publishedBy">;
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

  /** 중복 확인 표시는 확인한 도서의 ID여야 한다. 후보가 없으면 값이 쓰이지 않아 도메인은 틀린 값을 알아채지 못하므로 형식은 어댑터가 확인한다 */
  const assertAcknowledgementIsUuid = (value: unknown) => {
    if (value !== undefined && !isUuid(value)) throw new AppError("VALIDATION_ERROR", "acknowledgeDuplicateOf must be a book id");
  };

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
      assertAcknowledgementIsUuid(request.acknowledgeDuplicateOf);
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
      assertAcknowledgementIsUuid(request.acknowledgeDuplicateOf);
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

  const publishOnce = (actor: Actor, request: PublishTemplateVersionBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const valid = isUuid(request.tenantId) && typeof request.key === "string";
      // 같은 템플릿의 동시 게시를 직렬화한다(락을 잡은 뒤에 읽어야 먼저 커밋된 버전이 보인다)
      if (valid) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`tpl:${request.tenantId}:${request.key}`]);
      const versions: TemplateVersion[] = valid
        ? (await client.query("select * from public.ordering_template_versions where tenant_id = $1 and key = $2 order by version", [request.tenantId, request.key])).rows.map(
            (v): TemplateVersion => ({ id: v.id, tenantId: v.tenant_id, key: v.key, version: Number(v.version), body: v.body, variables: v.variables, publishedBy: v.published_by, publishedAt: v.published_at.toISOString(), recordedAt: v.recorded_at.toISOString() }),
          )
        : [];
      const delegated = isUuid(request.tenantId)
        ? (await client.query("select 1 from public.ordering_management_delegations where tenant_id = $1 and user_id = $2", [request.tenantId, actor.userId])).rowCount === 1
        : false;
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: TemplateVersion[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.publishTemplateVersion(
        { templateVersions: { list: () => versions, save: (v) => void saved.push(v) }, managementDelegations: { isDelegated: (_t2, userId) => delegated && userId === actor.userId }, idempotency },
        principal,
        rest,
      );
      for (const v of saved) {
        await client.query(
          "insert into public.ordering_template_versions (id, tenant_id, key, version, body, variables, published_by, published_at, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [v.id, v.tenantId, v.key, v.version, v.body, v.variables, v.publishedBy, v.publishedAt, v.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  return {
    publishTemplateVersion: (actor: Actor, request: PublishTemplateVersionBody) => withRetry(() => publishOnce(actor, request)),
    updateBook: (actor: Actor, request: UpdateBookBody) => withRetry(() => updateOnce(actor, request)),
    registerBook: (actor: Actor, request: RegisterBookBody) => withRetry(() => registerOnce(actor, request)),
  };
}
