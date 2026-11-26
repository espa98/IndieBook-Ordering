import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 주문 목록의 페이지네이션은 SQL에서 한다(전에는 서점의 주문 전체를 적재해 도메인에서 걸렀다).
 * 한 페이지를 읽을 때 DB가 돌려준 주문·품목 행 수가 페이지 크기에 비례해야 하고, 결과(순서·커서·상태 필터)는 전과 같아야 한다.
 */
const T = "aaaaaaaa-0000-4000-8000-000000000006";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000007";
const OWNER = "11111111-0000-4000-8000-000000000006";
const TOTAL = 120;

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
          const sql = typeof args[0] === "string" ? args[0] : "";
          fetched.push({ sql, rows: result?.rowCount ?? 0 });
          return result;
        };
      }
      return client;
    },
  };
};

beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  for (const [t, owner] of [[T, OWNER], [OTHER, "11111111-0000-4000-8000-000000000007"]]) {
    await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [t, owner]);
    await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [t, owner]);
  }
  // 120건: 3건마다 같은 created_at(동률은 id로 가른다). 품목은 초안에만 넣을 수 있으므로 먼저 넣고 3건 중 하나를 확정한다
  await c.query(
    `insert into public.ordering_orders (id, tenant_id, status, created_at)
     select gen_random_uuid(), $1, 'DRAFT', timestamptz '2026-03-01 00:00:00+00' + ((n / 3) * interval '1 minute')
       from generate_series(1, ${TOTAL}) n`,
    [T],
  );
  await c.query(`insert into public.ordering_orders (id, tenant_id, status, created_at) select gen_random_uuid(), $1, 'DRAFT', now() from generate_series(1, 30)`, [OTHER]);
  await c.query(
    `insert into public.ordering_order_lines (id, tenant_id, order_id, position, book_key, quantity, unit_price_krw)
     select gen_random_uuid(), tenant_id, id, 1, 'b', 1, 1000 from public.ordering_orders`,
  );
  await c.query(
    `update public.ordering_orders o set status = 'CONFIRMED', version = 2, display_number = r.n, total_krw = 1000
       from (select id, row_number() over (order by id) as n from public.ordering_orders where tenant_id = $1) r
      where o.id = r.id and r.n % 3 = 0`,
    [T],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const expectedIds = async (status?: string): Promise<string[]> => {
  const c = await db.connect();
  try {
    const sql = `select id from public.ordering_orders where tenant_id = $1 ${status ? "and status = $2" : ""} order by created_at desc, id desc`;
    return (await c.query(sql, status ? [T, status] : [T])).rows.map((r) => r.id as string);
  } finally {
    await c.end();
  }
};

describe("주문 목록 SQL 페이지네이션", () => {
  it("한 페이지를 읽을 때 DB가 돌려준 주문·품목 행이 페이지 크기(+1)를 넘지 않는다", async () => {
    const api = createPgOrderApi({ pool: spyPool() });
    fetched.length = 0;
    const page = await api.listOrders({ userId: OWNER }, { tenantId: T, limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeDefined();
    const orderRows = fetched.filter((f) => /from public\.ordering_orders/.test(f.sql)).reduce((n, f) => n + f.rows, 0);
    const lineRows = fetched.filter((f) => /from public\.ordering_order_lines/.test(f.sql)).reduce((n, f) => n + f.rows, 0);
    expect(orderRows, "주문 행").toBeLessThanOrEqual(6);
    expect(lineRows, "품목 행").toBeLessThanOrEqual(6);
  });

  it("커서를 따라 끝까지 걸으면 전부 한 번씩 최신순(동률은 id 내림차순)으로 나오고, 상태 필터와 다른 서점 격리도 유지된다", async () => {
    const api = createPgOrderApi({ pool: spyPool() });
    for (const status of [undefined, "DRAFT", "CONFIRMED"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await api.listOrders({ userId: OWNER }, { tenantId: T, limit: 7, ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) });
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 100);
      expect(seen, `status=${status}`).toEqual(await expectedIds(status));
    }
  });

  it("마지막 페이지는 nextCursor가 없고, 페이지 크기와 개수가 정확히 같을 때도 빈 다음 페이지를 알리지 않는다", async () => {
    const api = createPgOrderApi({ pool: spyPool() });
    const all = await api.listOrders({ userId: OWNER }, { tenantId: T, limit: 100 });
    expect(all.items).toHaveLength(100);
    const rest = await api.listOrders({ userId: OWNER }, { tenantId: T, limit: 100, cursor: all.nextCursor });
    expect(rest.items).toHaveLength(TOTAL - 100);
    expect(rest.nextCursor).toBeUndefined();
    const confirmed = await api.listOrders({ userId: OWNER }, { tenantId: T, limit: 40, status: "CONFIRMED" });
    expect(confirmed.items).toHaveLength(40);
    expect(confirmed.nextCursor).toBeUndefined();
  });
});

describe("주문 목록: 잘못된 요청의 처리 순서", () => {
  const codeOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "OK";
    } catch (error) {
      return (error as { code?: string }).code ?? "NON_APP_ERROR";
    }
  };
  const bad = (cursor: string) => cursor;
  it("한도·상태·커서 형식 오류는 400, 비멤버는 같은 잘못된 요청이어도 403(인증이 먼저), DB에 있을 수 없는 커서는 빈 페이지이며 전체 적재를 하지 않는다", async () => {
    const api = createPgOrderApi({ pool: spyPool() });
    const STRANGER = "99999999-0000-4000-8000-000000000001";
    expect(await codeOf(() => api.listOrders({ userId: OWNER }, { tenantId: T, limit: 0 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api.listOrders({ userId: OWNER }, { tenantId: T, status: "X" as never }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api.listOrders({ userId: OWNER }, { tenantId: T, cursor: bad("%%%") }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api.listOrders({ userId: STRANGER }, { tenantId: T, limit: 0 }))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.listOrders({ userId: STRANGER }, { tenantId: T, cursor: bad("%%%") }))).toBe("FORBIDDEN");

    fetched.length = 0;
    const unreachable = btoa(JSON.stringify(["2026-03-01T00:00:00.000Z", "not-a-uuid"]));
    const page = await api.listOrders({ userId: OWNER }, { tenantId: T, cursor: unreachable });
    expect(page.items).toEqual([]);
    const garbageDate = btoa(JSON.stringify(["yesterday", "aaaaaaaa-0000-4000-8000-000000000001"]));
    expect((await api.listOrders({ userId: OWNER }, { tenantId: T, cursor: garbageDate })).items).toEqual([]);
    expect(fetched.filter((f) => /from public\.ordering_orders/.test(f.sql)).reduce((n, f) => n + f.rows, 0)).toBe(0);
  });
});

describe("주문 목록 인덱스", () => {
  it("(tenant_id, created_at desc, id desc) 인덱스가 있어 한 페이지가 서점의 주문 수와 무관하게 읽힌다", async () => {
    const c = await db.connect();
    try {
      const defs = (await c.query("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'ordering_orders'")).rows.map((r) => r.indexdef as string);
      expect(defs.some((d) => /\(tenant_id, created_at DESC, id DESC\)/.test(d)), defs.join("\n")).toBe(true);
      await c.query("analyze public.ordering_orders");
      await c.query("set enable_seqscan = off");
      const plan = (await c.query("explain select * from public.ordering_orders where tenant_id = $1 order by created_at desc, id desc limit 6", [T])).rows.map((r) => r["QUERY PLAN"] as string).join("\n");
      expect(plan).toMatch(/Index Scan/);
      expect(plan).not.toMatch(/Sort/);
    } finally {
      await c.end();
    }
  });
});
