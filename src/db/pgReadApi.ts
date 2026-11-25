import type { PoolClient } from "pg";
import type { TemplateVersion } from "../catalog/messageTemplate";
import { normalizeIsbn, type Book, type BookRevision } from "../catalog/registerBook";
import { AppError } from "../errors/AppError";
import { longUnreceivedWarnings, type LongUnreceivedWarning } from "../notification/longUnreceivedWarnings";
import { notificationState, type NotificationStatus } from "../notification/notificationState";
import type { NotificationTarget } from "../notification/createNotificationTarget";
import type { NotificationAttempt } from "../notification/recordNotificationAttempt";
import type { NotificationResult } from "../notification/recordNotificationResult";
import { toBook } from "./pgCatalogApi";
import { loadSecuredDeps, toAttempt, toResult, toTarget } from "./pgNotificationApi";
import { inTransaction, isUuid, loadMembership, loadOrders, principalFor, type PoolLike } from "./pgSupport";

type Actor = { userId: string };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const validation = (message: string) => new AppError("VALIDATION_ERROR", message);

function pageSize(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw validation("limit must be an integer 1..100");
  return value;
}

/** 불투명 커서: 정렬 키 배열을 base64 JSON으로 감싼다. 형식이 맞지 않으면 400 */
const encodeCursor = (key: string[]) => btoa(unescape(encodeURIComponent(JSON.stringify(key))));
function decodeCursor(cursor: string, size: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(escape(atob(cursor))));
  } catch {
    throw validation("invalid cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== size || !parsed.every((p) => typeof p === "string")) throw validation("invalid cursor");
  return parsed as string[];
}

/** 안내 대상과 기록에서 파생한 상태(BR-M01) */
export type NotificationTargetView = NotificationTarget & {
  status: NotificationStatus;
  attemptCount: number;
  lastAttempt?: NotificationAttempt;
  lastResult?: NotificationResult;
};

export type ListMessageTemplatesRequest = { tenantId: string; key?: string };

const toTemplate = (v: any): TemplateVersion => ({
  id: v.id,
  tenantId: v.tenant_id,
  key: v.key,
  version: Number(v.version),
  body: v.body,
  variables: v.variables,
  publishedBy: v.published_by,
  publishedAt: v.published_at.toISOString(),
  recordedAt: v.recorded_at.toISOString(),
});

const toRevision = (r: any): BookRevision => ({
  id: r.id,
  tenantId: r.tenant_id,
  bookId: r.book_id,
  versionBefore: Number(r.version_before),
  versionAfter: Number(r.version_after),
  before: r.before,
  after: r.after,
  reason: r.reason,
  changedBy: r.changed_by,
  changedAt: r.changed_at.toISOString(),
});

export type ListBooksRequest = { tenantId: string; limit?: number; cursor?: string; isbn?: string };

/**
 * 조회 전용 API. 쓰기 어댑터와 같은 규칙으로 매 요청 활성 멤버십을 DB에서 확인하고(Owner·직원 모두 읽을 수 있다),
 * 서점 범위의 행만 돌려준다. 페이지 크기는 기본 20·최대 100이고 커서는 불투명 문자열이다.
 */
export function createPgReadApi(deps: { pool: PoolLike; now?: () => Date }) {
  /** 멤버십을 확인한 뒤 읽기 전용으로 실행한다 */
  const asMember = <T>(actor: Actor, tenantId: string, run: (client: PoolClient) => Promise<T>): Promise<T> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      principalFor(await loadMembership(client, actor.userId, tenantId), actor.userId, tenantId);
      return run(client);
    });

  /** 다른 서점의 도서와 없는 도서는 같은 404다(존재 비노출) */
  async function requireBook(client: PoolClient, tenantId: string, bookId: string): Promise<Book> {
    const row = isUuid(bookId) ? (await client.query("select * from public.ordering_books where tenant_id = $1 and id = $2", [tenantId, bookId])).rows[0] : undefined;
    if (!row) throw new AppError("NOT_FOUND");
    return toBook(row);
  }

  return {
    getBook: (actor: Actor, request: { tenantId: string; bookId: string }): Promise<Book> =>
      asMember(actor, request.tenantId, (client) => requireBook(client, request.tenantId, request.bookId)),

    listBookRevisions: (actor: Actor, request: { tenantId: string; bookId: string }): Promise<BookRevision[]> =>
      asMember(actor, request.tenantId, async (client) => {
        await requireBook(client, request.tenantId, request.bookId);
        return (await client.query("select * from public.ordering_book_revisions where tenant_id = $1 and book_id = $2 order by version_after", [request.tenantId, request.bookId])).rows.map(toRevision);
      }),

    /** 키를 주면 그 템플릿의 모든 버전(오래된 순), 아니면 키별 최신 버전 */
    listMessageTemplates: (actor: Actor, request: ListMessageTemplatesRequest): Promise<TemplateVersion[]> =>
      asMember(actor, request.tenantId, async (client) => {
        if (request.key !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(request.key)) throw validation("invalid template key");
        const rows =
          request.key === undefined
            ? (await client.query("select distinct on (key) * from public.ordering_template_versions where tenant_id = $1 order by key, version desc", [request.tenantId])).rows
            : (await client.query("select * from public.ordering_template_versions where tenant_id = $1 and key = $2 order by version", [request.tenantId, request.key])).rows;
        return rows.map(toTemplate);
      }),

    listNotificationTargets: (actor: Actor, request: { tenantId: string; orderId: string }): Promise<NotificationTargetView[]> =>
      asMember(actor, request.tenantId, async (client) => {
        const [order] = await loadOrders(client, request.tenantId, { orderId: request.orderId });
        if (!order) throw new AppError("NOT_FOUND");
        const targets = (await client.query("select * from public.ordering_notification_targets where tenant_id = $1 and order_id = $2 order by recorded_at, id", [request.tenantId, order.id])).rows.map(toTarget);
        const ids = targets.map((t) => t.id);
        const attempts = (await client.query("select * from public.ordering_notification_attempts where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, ids])).rows.map(toAttempt);
        const results = (await client.query("select * from public.ordering_notification_results where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, ids])).rows.map(toResult);
        return targets.map((target): NotificationTargetView => {
          const mine = { attempts: attempts.filter((a) => a.targetId === target.id), results: results.filter((x) => x.targetId === target.id) };
          const lastAttempt = mine.attempts[mine.attempts.length - 1];
          const lastResult = mine.results[mine.results.length - 1];
          return { ...target, status: notificationState(mine), attemptCount: mine.attempts.length, ...(lastAttempt ? { lastAttempt } : {}), ...(lastResult ? { lastResult } : {}) };
        });
      }),

    /** 안내를 마친 뒤 기준일(기본 7일)이 지나도 확보분이 남은 주문 목록(DEC-07: 목록만, 자동 조치 없음) */
    longUnreceivedWarnings: (actor: Actor, request: { tenantId: string; thresholdDays?: number }): Promise<LongUnreceivedWarning[]> =>
      asMember(actor, request.tenantId, async (client) => {
        const thresholdDays = request.thresholdDays ?? 7;
        if (!Number.isInteger(thresholdDays) || thresholdDays < 1 || thresholdDays > 365) throw validation("thresholdDays must be an integer 1..365");
        const now = (deps.now ?? (() => new Date()))();
        // 안내 완료(MANUAL_RECORDED)가 기준일 이상 지난 주문만 후보로 좁힌 뒤, 그 주문들에 도메인 계산을 그대로 적용한다
        const candidates = (
          await client.query(
            `select distinct t.order_id from public.ordering_notification_results r
               join public.ordering_notification_targets t on t.tenant_id = r.tenant_id and t.id = r.target_id
              where r.tenant_id = $1 and r.outcome = 'MANUAL_RECORDED' and r.result_at <= $2::timestamptz - make_interval(days => $3)`,
            [request.tenantId, now.toISOString(), thresholdDays],
          )
        ).rows.map((r) => r.order_id as string);
        const warnings: LongUnreceivedWarning[] = [];
        for (const orderId of candidates) {
          const [order] = await loadOrders(client, request.tenantId, { orderId });
          if (!order) continue;
          const targets = (await client.query("select * from public.ordering_notification_targets where tenant_id = $1 and order_id = $2 order by recorded_at, id", [request.tenantId, orderId])).rows.map(toTarget);
          const ids = targets.map((t) => t.id);
          const attempts = (await client.query("select * from public.ordering_notification_attempts where tenant_id = $1 and target_id = any($2::uuid[])", [request.tenantId, ids])).rows.map(toAttempt);
          const results = (await client.query("select * from public.ordering_notification_results where tenant_id = $1 and target_id = any($2::uuid[]) order by recorded_at, id", [request.tenantId, ids])).rows.map(toResult);
          warnings.push(
            ...longUnreceivedWarnings(
              {
                ...(await loadSecuredDeps(client, request.tenantId, order)),
                orders: { list: () => [order] },
                notificationTargets: { list: () => targets },
                notificationAttempts: { list: (_t: string, id: string) => attempts.filter((a) => a.targetId === id) },
                notificationResults: { list: (_t: string, id: string) => results.filter((x) => x.targetId === id) },
              },
              request.tenantId,
              now,
              thresholdDays,
            ),
          );
        }
        return warnings.sort((a, b) => b.daysElapsed - a.daysElapsed || (a.orderId < b.orderId ? -1 : 1));
      }),

    listBooks: (actor: Actor, request: ListBooksRequest): Promise<{ items: Book[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = pageSize(request.limit);
        const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, 2);
        const isbn = request.isbn === undefined ? undefined : normalizeIsbn(request.isbn);
        const rows = (
          await client.query(
            `select * from public.ordering_books
              where tenant_id = $1
                and ($2::text is null or isbn = $2)
                and ($3::text is null or (title, id::text) > ($3, $4))
              order by title, id
              limit $5`,
            [request.tenantId, isbn ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { items: page.map(toBook), ...(rows.length > limit && last ? { nextCursor: encodeCursor([last.title, last.id]) } : {}) };
      }),
  };
}

