import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BookSearchItem, BookSearchProvider } from "../../src/catalog/bookSearch";
import { searchUnavailable } from "../../src/catalog/bookSearch";
import { createPgBookSearchApi } from "../../src/db/pgBookSearchApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** UC-04 YES24 도서 검색: 활성 멤버만, 서버가 YES24 어댑터를 호출하고, 이미 등록한 도서(ISBN)는 표시하며, 장애는 503으로 알린다 */
const T = "aaaaaaaa-0000-4000-8000-0000000000ce";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000cf";
const OWNER = "11111111-0000-4000-8000-0000000000ce";
const STAFF = "11111111-0000-4000-8000-0000000000cf";
const EX_STAFF = "11111111-0000-4000-8000-0000000000d0";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000d1";
const STRANGER = "99999999-0000-4000-8000-0000000000ce";
const NOW = new Date("2026-03-10T00:00:00.000Z");

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);
  await c.query(`insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values ('b0000000-0000-4000-8000-0000000000ce', $1, '이미 등록한 책', '{}', '9788960901234', 15000, 'MANUAL', '시험', 'seed', now())`, [T]);
  // 다른 서점이 같은 ISBN을 등록해 둔 도서(이 서점에는 보이지 않아야 한다)
  await c.query(`insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values ('b0000000-0000-4000-8000-0000000000cf', $1, '남의 책', '{}', '9788996010000', 9000, 'MANUAL', '시험', 'seed', now())`, [OTHER_T]);
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const ITEMS: BookSearchItem[] = [
  { id: "Y1", title: "독립서점 운영기", authors: ["박서점"], isbn: "9788960901234", listPriceKrw: "16800" },
  { id: "Y2", title: "책방의 오후", authors: [], isbn: "9788996010000" },
  { id: "Y3", title: "ISBN 없는 책", authors: [] },
];
const provider = (impl: BookSearchProvider["search"]): BookSearchProvider => ({ name: "YES24", search: impl });
const api = (p?: BookSearchProvider) => createPgBookSearchApi({ pool: db.pool(), ...(p ? { provider: p } : {}), now: () => NOW });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const owner = { userId: OWNER };

describe("YES24 도서 검색 (UC-04)", () => {
  it("활성 멤버가 검색하면 출처·조회 시각과 결과를 받고, 이 서점에 이미 있는 ISBN의 도서는 existingBookId로 표시된다(다른 서점의 도서는 표시되지 않는다)", async () => {
    const seen: unknown[] = [];
    const result = await api(provider(async (q) => (seen.push(q), ITEMS))).search({ userId: STAFF }, { tenantId: T, type: "TITLE", q: " 운영기 ", limit: 5 });
    expect(seen).toEqual([{ type: "TITLE", q: "운영기", limit: 5 }]); // 검증·정리된 요청이 어댑터로 간다
    expect(result.source).toBe("YES24");
    expect(result.fetchedAt).toBe(NOW.toISOString());
    expect(result.items.map((i) => [i.id, i.existingBookId ?? null])).toEqual([["Y1", "b0000000-0000-4000-8000-0000000000ce"], ["Y2", null], ["Y3", null]]);
    expect(result.items[0]).toMatchObject({ title: "독립서점 운영기", listPriceKrw: "16800" });
  });

  it("어댑터가 없거나(미설정) 실패하면 SERVICE_UNAVAILABLE이고, 다른 어댑터로 넘어가지 않으며, 한 번의 실패가 다음 검색을 막지 않는다", async () => {
    expect(await codeOf(() => api().search(owner, { tenantId: T, type: "TITLE", q: "x" }))).toBe("SERVICE_UNAVAILABLE");
    let calls = 0;
    const flaky = provider(async () => {
      calls++;
      if (calls === 1) throw searchUnavailable();
      if (calls === 2) throw new Error("뜻밖의 오류 secret-key");
      return ITEMS;
    });
    const a = api(flaky);
    expect(await codeOf(() => a.search(owner, { tenantId: T, type: "TITLE", q: "x" }))).toBe("SERVICE_UNAVAILABLE");
    expect(await codeOf(() => a.search(owner, { tenantId: T, type: "TITLE", q: "x" }))).toBe("SERVICE_UNAVAILABLE"); // 알 수 없는 오류도 503으로 바꾼다(원인은 노출하지 않는다)
    expect((await a.search(owner, { tenantId: T, type: "TITLE", q: "x" })).items).toHaveLength(3);
  });

  it("잘못된 요청은 VALIDATION_ERROR(어댑터를 부르지 않는다), 비멤버·비활성·다른 서점 Owner는 FORBIDDEN(검증보다 먼저)이다", async () => {
    let calls = 0;
    const a = api(provider(async () => (calls++, ITEMS)));
    for (const bad of [{ type: "ALL", q: "x" }, { type: "TITLE", q: "" }, { type: "ISBN", q: "123" }, { type: "TITLE", q: "x", limit: 99 }]) {
      expect(await codeOf(() => a.search(owner, { tenantId: T, ...bad } as never)), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => a.search({ userId }, { tenantId: T, type: "ALL", q: "" } as never)), userId).toBe("FORBIDDEN");
    expect(calls).toBe(0);
  });

  it("연동 상태(S-08): 설정 여부와 마지막 검색 결과(시각·성공 여부)만 알려 주고 키·주소는 없다", async () => {
    const never = api();
    expect(await never.status(owner, { tenantId: T })).toEqual({ provider: "YES24", configured: false });
    let fail = true;
    const a = api(provider(async () => {
      if (fail) throw searchUnavailable();
      return ITEMS;
    }));
    expect(await a.status(owner, { tenantId: T })).toEqual({ provider: "YES24", configured: true });
    await codeOf(() => a.search(owner, { tenantId: T, type: "TITLE", q: "x" }));
    expect(await a.status({ userId: STAFF }, { tenantId: T })).toEqual({ provider: "YES24", configured: true, lastSearch: { at: NOW.toISOString(), ok: false } });
    fail = false;
    await a.search(owner, { tenantId: T, type: "TITLE", q: "x" });
    expect((await a.status(owner, { tenantId: T })).lastSearch).toEqual({ at: NOW.toISOString(), ok: true });
    for (const userId of [STRANGER, EX_STAFF]) expect(await codeOf(() => a.status({ userId }, { tenantId: T })), userId).toBe("FORBIDDEN");
  });

  it("동시에 진행 중인 상류 호출은 4개까지만 받고 그 이상은 SERVICE_UNAVAILABLE이다(상류 보호)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const a = api(provider(async () => (started++, await gate, ITEMS)));
    const first = Array.from({ length: 4 }, () => codeOf(() => a.search(owner, { tenantId: T, type: "TITLE", q: "x" })));
    // 4개가 모두 상류에 들어가 대기할 때까지 기다린다(부하에서도 흔들리지 않도록 시간이 아니라 진행 상황으로 판단한다)
    for (let i = 0; i < 200 && started < 4; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(4);
    expect(await codeOf(() => a.search(owner, { tenantId: T, type: "TITLE", q: "x" }))).toBe("SERVICE_UNAVAILABLE"); // 5번째는 즉시 거부된다
    expect(started).toBe(4); // 거부된 호출은 상류에 가지 않았다
    release();
    expect(await Promise.all(first)).toEqual(["OK", "OK", "OK", "OK"]);
    expect(await codeOf(() => a.search(owner, { tenantId: T, type: "TITLE", q: "x" }))).toBe("OK"); // 끝나면 다시 받는다
  });
});
