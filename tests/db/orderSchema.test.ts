import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres, withJwt } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const ORDER_A_DRAFT = "0a000000-0000-4000-8000-000000000001";
const ORDER_A_CONFIRMED = "0a000000-0000-4000-8000-000000000002";
const ORDER_B_CONFIRMED = "0b000000-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values
       ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false), ($5, $6, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, EX_STAFF_A, T_B, OWNER_B],
  );
  // 실제 흐름대로: 초안 생성 → 품목 추가 → 확정
  await c.query(
    `insert into public.ordering_orders (id, tenant_id) values ($1, $4), ($2, $4), ($3, $5)`,
    [ORDER_A_DRAFT, ORDER_A_CONFIRMED, ORDER_B_CONFIRMED, T_A, T_B],
  );
  await c.query(
    `insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw) values
       ($1, $2, 1, 'book-1', 2, 15000), ($3, $4, 1, 'book-9', 1, 9000)`,
    [T_A, ORDER_A_CONFIRMED, T_B, ORDER_B_CONFIRMED],
  );
  await c.query(
    `update public.ordering_orders set status = 'CONFIRMED', version = version + 1, display_number = 1,
            total_krw = case id when $1 then 30000 else 9000 end
      where id in ($1, $2)`,
    [ORDER_A_CONFIRMED, ORDER_B_CONFIRMED],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const authed = (sub: string, extra: Record<string, unknown> = {}) => ({
  role: "authenticated" as const,
  claims: { sub, ...extra },
});

describe("주문·품목 읽기 RLS", () => {
  it("활성 멤버는 자기 서점의 주문·품목만 보고, 다른 서점의 UUID를 지정해도 0행이다", async () => {
    const c = await db.connect();
    try {
      const ids = (sub: string, table: string) =>
        withJwt(c, authed(sub), async () => (await c.query(`select tenant_id from public.${table}`)).rows.map((r) => r.tenant_id));

      expect(await ids(OWNER_A, "ordering_orders")).toEqual([T_A, T_A]);
      expect(await ids(STAFF_A, "ordering_orders")).toEqual([T_A, T_A]);
      expect(await ids(OWNER_B, "ordering_orders")).toEqual([T_B]);
      expect(await ids(STAFF_A, "ordering_order_lines")).toEqual([T_A]);
      const guessed = await withJwt(c, authed(OWNER_A), async () =>
        (await c.query("select id from public.ordering_orders where id = $1", [ORDER_B_CONFIRMED])).rows,
      );
      expect(guessed).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("비멤버·비활성 직원은 아무것도 보지 못하고 anon은 42501이다", async () => {
    const c = await db.connect();
    try {
      for (const sub of [STRANGER, EX_STAFF_A]) {
        const rows = await withJwt(c, authed(sub, { role: "OWNER" }), async () =>
          (await c.query("select id from public.ordering_orders")).rows,
        );
        expect(rows, sub).toEqual([]);
      }
      for (const table of ["ordering_orders", "ordering_order_lines"]) {
        expect(await withJwt(c, { role: "anon", claims: null }, () => sqlState(() => c.query(`select * from public.${table}`)))).toBe("42501");
      }
    } finally {
      await c.end();
    }
  });

  it("authenticated는 주문·품목을 직접 INSERT·UPDATE·DELETE할 수 없다", async () => {
    const c = await db.connect();
    try {
      for (const sql of [
        `insert into public.ordering_orders (tenant_id) values ('${T_A}')`,
        `update public.ordering_orders set version = version + 1 where id = '${ORDER_A_DRAFT}'`,
        `delete from public.ordering_orders where id = '${ORDER_A_DRAFT}'`,
        `update public.ordering_order_lines set quantity = 1 where tenant_id = '${T_A}'`,
        `delete from public.ordering_order_lines where tenant_id = '${T_A}'`,
      ]) {
        expect(await withJwt(c, authed(OWNER_A), () => sqlState(() => c.query(sql))), sql).toBe("42501");
      }
    } finally {
      await c.end();
    }
  });
});

describe("주문·품목 DB 불변식", () => {
  it("다른 서점의 주문에 품목을 붙이는 교차 서점 연결은 복합 FK가 거부한다 (RLS-04)", async () => {
    const c = await db.connect();
    try {
      const code = await sqlState(() =>
        c.query(
          `insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw)
           values ('${T_B}', '${ORDER_A_DRAFT}', 1, 'book-x', 1, 1000)`,
        ),
      );
      expect(code).toBe("23503");
    } finally {
      await c.end();
    }
  });

  it("품목은 DRAFT 주문에만 추가할 수 있고(확정 주문은 거부), 수량·단가·키 제약을 지킨다", async () => {
    const c = await db.connect();
    try {
      const insert = (order: string, extra = "1, 'book-2', 1, 1000") =>
        sqlState(() =>
          c.query(`insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw) values ('${T_A}', '${order}', ${extra})`),
        );
      expect(await insert(ORDER_A_CONFIRMED, "2, 'book-2', 1, 1000")).toBe("P0001");
      expect(await insert(ORDER_A_DRAFT, "1, 'book-2', 0, 1000")).toBe("P0001"); // 새 품목 수량은 1 이상
      expect(await insert(ORDER_A_DRAFT, "1, 'book-2', -1, 1000")).toBe("23514");
      expect(await insert(ORDER_A_DRAFT, "1, 'book-2', 1, -5")).toBe("23514");
      expect(await insert(ORDER_A_DRAFT, "1, ' ', 1, 1000")).toBe("23514");
      expect(await insert(ORDER_A_DRAFT, "1, 'book-2', 1, 1000")).toBeUndefined();
      expect(await insert(ORDER_A_DRAFT, "1, 'book-3', 1, 1000")).toBe("23505"); // 같은 위치 중복
      await c.query(`delete from public.ordering_order_lines where order_id = '${ORDER_A_DRAFT}'`);
    } finally {
      await c.end();
    }
  });

  it("품목은 수량 감소(취소 적용)만 가능하고 도서·단가·소속은 바꿀 수 없다", async () => {
    const c = await db.connect();
    try {
      const update = (set: string) =>
        sqlState(() => c.query(`update public.ordering_order_lines set ${set} where order_id = '${ORDER_A_CONFIRMED}'`));
      expect(await update("quantity = 3")).toBe("P0001"); // 증가 불가
      expect(await update("unit_price_krw = 1")).toBe("P0001");
      expect(await update("book_key = 'other'")).toBe("P0001");
      expect(await update(`order_id = '${ORDER_A_DRAFT}'`)).toBe("P0001");
      expect(await update("quantity = 1")).toBeUndefined();
      await c.query(`update public.ordering_order_lines set quantity = 2 where order_id = '${ORDER_A_CONFIRMED}'`).catch(() => undefined);
    } finally {
      await c.end();
    }
  });

  it("확정 주문만 표시번호·합계를 가지며 표시번호는 서점 안에서 유일하고 서로 다른 서점은 같은 번호를 쓸 수 있다", async () => {
    const c = await db.connect();
    try {
      const insert = (tenant: string, status: string, num: string, total: string) =>
        sqlState(() =>
          c.query(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ('${tenant}', '${status}', ${num}, ${total})`),
        );
      expect(await insert(T_A, "DRAFT", "5", "null")).toBe("23514"); // 초안은 표시번호가 없다
      expect(await insert(T_A, "CONFIRMED", "null", "1000")).toBe("23514"); // 확정은 표시번호가 있다
      expect(await insert(T_A, "CONFIRMED", "7", "null")).toBe("23514"); // 확정은 합계가 있다
      expect(await insert(T_A, "CONFIRMED", "1", "1000")).toBe("23505"); // 서점 A에 이미 1번이 있다
      expect(await insert(T_A, "CONFIRMED", "2", "1000")).toBeUndefined();
      expect(await insert(T_B, "CONFIRMED", "2", "1000")).toBeUndefined(); // 다른 서점은 같은 번호 가능
      expect(await insert(T_A, "ARCHIVED", "null", "null")).toBe("23514");
    } finally {
      await c.end();
    }
  });

  it("주문 갱신은 version을 정확히 1 올려야 하고, CONFIRMED는 DRAFT로 돌아갈 수 없으며 서점·ID는 바뀌지 않는다", async () => {
    const c = await db.connect();
    try {
      const update = (set: string, id = ORDER_A_CONFIRMED) =>
        sqlState(() => c.query(`update public.ordering_orders set ${set} where id = '${id}'`));
      expect(await update("total_krw = 1")).toBe("P0001"); // version 미증가
      expect(await update("version = version + 2")).toBe("P0001");
      expect(await update("version = version + 1, status = 'DRAFT'")).toBe("P0001");
      expect(await update(`version = version + 1, tenant_id = '${T_B}'`)).toBe("P0001");
      expect(await update("version = version + 1, closed_at = now()")).toBeUndefined();
      expect(await update("version = version + 1, closed_at = null")).toBeUndefined(); // 재개(ST-O10)
      const draft = ORDER_A_DRAFT;
      expect(await update("version = version + 1, status = 'CONFIRMED', display_number = 3, total_krw = 100", draft)).toBeUndefined();
    } finally {
      await c.end();
    }
  });

  it("두 독립 세션이 같은 version으로 동시에 확정하면 하나만 갱신되고 다른 쪽은 0행 또는 거부된다 (낙관적 잠금)", async () => {
    const setup = await db.connect();
    await setup.query(`insert into public.ordering_orders (id, tenant_id) values ('0a000000-0000-4000-8000-0000000000aa', '${T_A}')`);
    await setup.end();
    const a = await db.connect();
    const b = await db.connect();
    const id = "0a000000-0000-4000-8000-0000000000aa";
    const confirm = (n: number) =>
      `update public.ordering_orders set status = 'CONFIRMED', version = version + 1, display_number = ${n}, total_krw = 0
        where id = '${id}' and version = 1`;
    try {
      await a.query("begin");
      await b.query("begin");
      const first = await a.query(confirm(50));
      const secondPromise = b.query(confirm(51)); // a가 커밋할 때까지 대기한다
      await a.query("commit");
      const second = await secondPromise; // 갱신 시점의 version이 이미 2이므로 조건에 맞는 행이 없다
      await b.query("commit");
      expect(first.rowCount).toBe(1);
      expect(second.rowCount).toBe(0);
      const check = await db.connect();
      const row = (await check.query(`select version, display_number from public.ordering_orders where id = '${id}'`)).rows[0];
      await check.end();
      expect(row).toEqual({ version: "2", display_number: "50" });
    } finally {
      await a.end();
      await b.end();
    }
  });
});
