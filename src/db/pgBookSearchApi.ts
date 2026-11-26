import { parseBookSearchRequest, searchUnavailable, type BookSearchItem, type BookSearchProvider } from "../catalog/bookSearch";
import { AppError } from "../errors/AppError";
import { inTransaction, loadMembership, principalFor, type PoolLike } from "./pgSupport";

type Actor = { userId: string };

/** 동시에 진행 중인 상류(YES24) 호출 상한. 넘으면 즉시 SERVICE_UNAVAILABLE로 거절해 상류와 서버 소켓을 보호한다 */
const MAX_IN_FLIGHT = 4;

/** 검색 결과 한 줄: 정리된 외부 도서 + 이 서점에 이미 같은 ISBN의 도서가 있으면 그 ID(중복 등록 경고용, ST-B03) */
export type BookSearchResultItem = BookSearchItem & { existingBookId?: string };
export type BookSearchResult = { source: "YES24"; fetchedAt: string; items: BookSearchResultItem[] };
/** 연동 상태(S-08). 키·주소는 싣지 않는다. 마지막 검색 결과는 이 서버 프로세스가 기억하는 값이다 */
export type BookSearchStatus = { provider: "YES24"; configured: boolean; lastSearch?: { at: string; ok: boolean } };

/**
 * YES24 도서 검색(UC-04, DEC-17). 활성 멤버만 쓰고, 서버가 단일 어댑터(YES24)를 호출한다. 어댑터가 없거나 실패하면 SERVICE_UNAVAILABLE이며
 * **다른 외부 API로 자동 전환하지 않는다**(수기 도서 등록으로 대체). 외부 호출 동안 DB 연결을 잡고 있지 않도록 멤버십 확인과 중복 조회를 짧은 트랜잭션으로 나눈다.
 */
export function createPgBookSearchApi(deps: { pool: PoolLike; provider?: BookSearchProvider; now?: () => Date }) {
  const now = () => (deps.now ?? (() => new Date()))();
  let inFlight = 0;
  let lastSearch: { at: string; ok: boolean } | undefined;

  const asMember = <T>(actor: Actor, tenantId: string, run: Parameters<typeof inTransaction<T>>[3]): Promise<T> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      principalFor(await loadMembership(client, actor.userId, tenantId), actor.userId, tenantId);
      return run(client);
    });

  return {
    search: async (actor: Actor, request: { tenantId: string; type?: unknown; q?: unknown; limit?: unknown }): Promise<BookSearchResult> => {
      await asMember(actor, request.tenantId, async () => undefined); // 권한이 검증보다 먼저다
      const query = parseBookSearchRequest(request);
      if (!deps.provider || inFlight >= MAX_IN_FLIGHT) throw searchUnavailable();
      inFlight++;
      let items: BookSearchItem[];
      try {
        items = await deps.provider.search(query);
        lastSearch = { at: now().toISOString(), ok: true };
      } catch (error) {
        lastSearch = { at: now().toISOString(), ok: false };
        // 알 수 없는 오류도 원인을 숨기고 503으로 바꾼다
        throw error instanceof AppError && error.code === "SERVICE_UNAVAILABLE" ? error : searchUnavailable();
      } finally {
        inFlight--;
      }
      const isbns = items.map((i) => i.isbn).filter((i): i is string => i !== undefined);
      const existing = new Map<string, string>();
      if (isbns.length > 0) {
        const rows = await asMember(actor, request.tenantId, async (client) =>
          (await client.query("select id, isbn from public.ordering_books where tenant_id = $1 and isbn = any($2::text[])", [request.tenantId, isbns])).rows,
        );
        for (const r of rows) existing.set(r.isbn as string, r.id as string);
      }
      return {
        source: "YES24",
        fetchedAt: now().toISOString(),
        items: items.map((i) => ({ ...i, ...(i.isbn && existing.has(i.isbn) ? { existingBookId: existing.get(i.isbn)! } : {}) })),
      };
    },

    status: async (actor: Actor, request: { tenantId: string }): Promise<BookSearchStatus> => {
      await asMember(actor, request.tenantId, async () => undefined);
      return { provider: "YES24", configured: deps.provider !== undefined, ...(lastSearch ? { lastSearch } : {}) };
    },
  };
}
