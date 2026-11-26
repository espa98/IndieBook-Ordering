import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** 주문 목록 검색(O-02): 표시번호·도서명·ISBN을 SQL에서 거른다. 검색 때문에 서점의 주문 전체를 읽지 않는다 */
const T = "aaaaaaaa-0000-4000-8000-0000000000f2";
const OWNER = "11111111-0000-4000-8000-0000000000f2";
const STRANGER = "99999999-0000-4000-8000-0000000000f2";

let db: IsolatedPostgres;
const fetched: { sql: string; rows: number }[] = [];
const spyPool = () => {
  const pool = db.pool();
  return {
    connect: async () => {
      const client = (await pool.connect()) as PoolClient & { __spied?: boolean };
      if (!client.__spied) {
        client.__spied = true;
        const original = client.query.bind(client) as (...args: unknown[]) => Promise<{ rowCount: number | null }>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const result = await original(...args);
          fetched.push({ sql: typeof args[0] === "string" ? args[0] : "", rows: result?.rowCount ?? 0 });
          return result;
        };
      }
      return client;
    },
  };
};
const api = () => createPgOrderApi({ pool: spyPool() });
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const ids: Record<string, string> = {};
let day = 0;

/** 초안으로 도서 스냅샷이 있는 품목을 넣고 확정한다 */
async function order(key: string, title: string, isbn: string | null, displayNumber?: number) {
  const createdAt = new Date(Date.UTC(2026, 2, 1 + ++day)).toISOString();
  const id = (await q(`insert into public.ordering_orders (tenant_id, status, created_at) values ($1, 'DRAFT', $2) returning id`, [T, createdAt]))[0].id as string;
  await q(`insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw, book_title, book_isbn) values ($1, $2, 1, 'b', 1, 1000, $3, $4)`, [T, id, title, isbn]);
  if (displayNumber !== undefined) await q(`update public.ordering_orders set status = 'CONFIRMED', version = 2, display_number = $2, total_krw = 1000 where id = $1`, [id, displayNumber]);
  ids[key] = id;
}

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await order("ops", "독립서점 운영기", "9788960901234", 12);
  await order("zen", "Zen and the Art", null, 123);
  await order("pm", "100% 완벽", null);
  await order("p0", "1000 완벽", null);
  await order("us", "밑줄_긋기", null);
  await order("ux", "밑줄X긋기", null);
  await order("bs", "경로\\책", null);
  // 검색이 전체 적재가 아님을 보이는 잡음(제목에 숫자를 넣지 않아 표시번호 검색과 섞이지 않는다)
  for (let i = 0; i < 80; i++) await order(`filler${i}`, `관계없는 책 ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`, null);
}, 240_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const search = (s: string, extra: Record<string, unknown> = {}) => api().listOrders({ userId: OWNER }, { tenantId: T, search: s, ...extra } as never);
const found = async (s: string, extra: Record<string, unknown> = {}) => (await search(s, extra)).items.map((i) => i.id);

describe("주문 목록 검색 (SQL)", () => {
  it("표시번호(정확히 일치)·도서명(부분 일치, 대소문자 무시)·ISBN(하이픈 무시, 정확히 일치)으로 찾는다", async () => {
    expect(await found("12")).toEqual([ids.ops]);
    expect(await found("123")).toEqual([ids.zen]);
    expect(await found("운영")).toEqual([ids.ops]);
    expect(await found("ZEN AND")).toEqual([ids.zen]);
    expect(await found("978-8960-901234")).toEqual([ids.ops]);
    expect(await found("9788960")).toEqual([]);
    expect(await found("없는책")).toEqual([]);
    expect(await found("운영", { status: "DRAFT" })).toEqual([]); // 다른 필터와 함께(운영기는 확정 주문)
    expect(await found("운영", { status: "CONFIRMED" })).toEqual([ids.ops]);
  });

  it("LIKE 와일드카드(%, _)와 역슬래시는 문자 그대로 찾는다", async () => {
    expect(await found("100%")).toEqual([ids.pm]); // 1000 완벽은 아니다
    expect(await found("밑줄_")).toEqual([ids.us]); // 밑줄X긋기는 아니다
    expect(await found("%")).toEqual([ids.pm]);
    expect(await found("_")).toEqual([ids.us]);
    expect(await found("경로\\")).toEqual([ids.bs]);
  });

  it("검색 결과도 커서로 이어지고, 검색은 한 페이지분만 읽는다(주문 전체를 적재하지 않는다)", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await search("관계없는", { limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(80);
    expect(new Set(seen).size).toBe(80);

    fetched.length = 0;
    const page = await search("관계없는", { limit: 5 });
    expect(page.items).toHaveLength(5);
    const orderRows = fetched.filter((f) => /from public\.ordering_orders/.test(f.sql)).reduce((n, f) => n + f.rows, 0);
    const lineRows = fetched.filter((f) => /^\s*select \* from public\.ordering_order_lines/.test(f.sql)).reduce((n, f) => n + f.rows, 0);
    expect(orderRows, "주문 행").toBeLessThanOrEqual(6);
    expect(lineRows, "품목 행").toBeLessThanOrEqual(6);
  });

  it("잘못된 search는 400(인증 뒤), 비멤버는 403이 먼저이고 검증 실패는 주문을 읽지 않는다", async () => {
    for (const bad of ["", "   ", "가".repeat(61), 5 as never]) expect(await codeOf(() => search(bad)), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api().listOrders({ userId: STRANGER }, { tenantId: T, search: "" } as never))).toBe("FORBIDDEN");
    fetched.length = 0;
    await codeOf(() => search(""));
    expect(fetched.filter((f) => /from public\.ordering_orders/.test(f.sql)).reduce((n, f) => n + f.rows, 0)).toBe(0);
  });
});
