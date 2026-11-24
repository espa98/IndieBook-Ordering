import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres, withJwt } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
  for (let n = 1; n <= 12; n++) {
    await c.query(
      `insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at)
       values ($1, $2, $3, 10000, 'MANUAL', '시험', 'seed', now())`,
      [BOOK(n), T_A, `책 ${n}`],
    );
  }
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
let seq = 0;
const key = () => `s-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const query = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};

/** 확정된 주문(품목 1개)을 만들고 재고를 시드한다 */
async function confirmedOrder(book: number, quantity: number) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "10000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  return { orderId: order.id, lineId: order.lines[0]!.lineId };
}
const seedStock = (book: number, quantity: number) =>
  query(
    `insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at)
     values ($1, $2, 'INITIAL', 'IN', $3, '초기 재고', 'seed', now())`,
    [T_A, BOOK(book), quantity],
  );
const reserveBody = (o: { orderId: string; lineId: string }, quantity: number) => ({
  tenantId: T_A,
  orderId: o.orderId,
  orderLineId: o.lineId,
  quantity,
  reservedAt: "2026-03-04T06:40:00.000Z",
  idempotencyKey: key(),
});

describe("createPgStockApi.reserveStock: 재고 예약을 Postgres 영속화로 실행", () => {
  it("예약하면 예약 기록이 저장되고 가용 재고가 줄며, 같은 멱등 키는 같은 예약을 돌려준다 (재시작 뒤에도)", async () => {
    await seedStock(1, 5);
    const o = await confirmedOrder(1, 2);
    const body = reserveBody(o, 2);

    const reservation = await createPgStockApi({ pool: db.pool() }).reserveStock(owner, body);
    const retry = await createPgStockApi({ pool: db.pool() }).reserveStock(owner, body);

    expect(reservation).toMatchObject({ tenantId: T_A, bookId: BOOK(1), orderId: o.orderId, orderLineId: o.lineId, quantity: 2, reservedBy: OWNER_A });
    expect(retry).toEqual(reservation);
    const rows = await query("select quantity, reserved_by from public.ordering_stock_reservations where order_line_id = $1", [o.lineId]);
    expect(rows).toEqual([{ quantity: 2, reserved_by: OWNER_A }]);
    expect(
      await codeOf(() => createPgStockApi({ pool: db.pool() }).reserveStock(owner, { ...body, quantity: 1 })),
    ).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("행위자는 요청이 아니라 인증된 사용자로 기록되고, 가용 재고·품목 미배정량을 넘으면 BUSINESS_INVARIANT이며 아무것도 저장되지 않는다", async () => {
    await seedStock(2, 3);
    const o = await confirmedOrder(2, 5);
    const api = createPgStockApi({ pool: db.pool() });

    const spoofed = await api.reserveStock({ userId: STAFF_A }, { ...reserveBody(o, 1), reservedBy: "점주" } as never);
    expect(spoofed.reservedBy).toBe(STAFF_A);

    expect(await codeOf(() => api.reserveStock(owner, reserveBody(o, 3)))).toBe("BUSINESS_INVARIANT"); // 가용 2
    await seedStock(2, 10); // 재고는 넉넉하지만 품목은 5권(이미 1권 예약)
    expect(await codeOf(() => api.reserveStock(owner, reserveBody(o, 5)))).toBe("BUSINESS_INVARIANT");
    expect(await query("select count(*)::int as n from public.ordering_stock_reservations where order_line_id = $1", [o.lineId])).toEqual([{ n: 1 }]);
    expect((await api.reserveStock(owner, reserveBody(o, 4))).quantity).toBe(4); // 한도 안은 통과
  });

  it("활성 조달 배정은 미배정량에서 빠지고, 초안 주문·없는 품목·타 서점 주문은 거부하며, 비멤버·비활성은 FORBIDDEN이다", async () => {
    await seedStock(3, 10);
    const o = await confirmedOrder(3, 2);
    await query(
      `insert into public.ordering_sourcing_allocations (tenant_id, order_id, order_line_id, supplier_code, quantity, status)
       values ($1, $2, $3, 'sup-a', 1, 'ACTIVE')`,
      [T_A, o.orderId, o.lineId],
    );
    const api = createPgStockApi({ pool: db.pool() });

    expect(await codeOf(() => api.reserveStock(owner, reserveBody(o, 2)))).toBe("BUSINESS_INVARIANT"); // 2 - 계획 1 = 1
    expect((await api.reserveStock(owner, reserveBody(o, 1))).quantity).toBe(1);

    const draft = await createPgOrderApi({ pool: db.pool() }).createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(3), quantity: 1, unitPriceKrw: "1" }] });
    expect(await codeOf(() => api.reserveStock(owner, reserveBody({ orderId: draft.id, lineId: draft.lines[0]!.lineId }, 1)))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => api.reserveStock(owner, reserveBody({ orderId: o.orderId, lineId: "0a000000-0000-4000-8000-00000000ffff" }, 1)))).toBe("NOT_FOUND");
    expect(await codeOf(() => api.reserveStock({ userId: OWNER_B }, { ...reserveBody(o, 1), tenantId: T_B }))).toBe("NOT_FOUND");
    expect(await codeOf(() => api.reserveStock({ userId: STRANGER }, reserveBody(o, 1)))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.reserveStock({ userId: EX_STAFF_A }, reserveBody(o, 1)))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.reserveStock({ userId: "" }, reserveBody(o, 1)))).toBe("UNAUTHENTICATED");
  });
});

describe("재고 예약의 실제 동시성 (두 독립 세션)", () => {
  it("마지막 1권을 두 고객 주문이 동시에 예약하면 하나만 성공하고 다른 쪽은 BUSINESS_INVARIANT이다", async () => {
    await seedStock(4, 1);
    const [o1, o2] = [await confirmedOrder(4, 1), await confirmedOrder(4, 1)];
    const apiA = createPgStockApi({ pool: db.pool() });
    const apiB = createPgStockApi({ pool: db.pool() });

    const results = await Promise.allSettled([apiA.reserveStock(owner, reserveBody(o1, 1)), apiB.reserveStock({ userId: STAFF_A }, reserveBody(o2, 1))]);

    const outcomes = results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();
    expect(outcomes).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await query("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservations where book_key = $1", [BOOK(4)])).toEqual([{ n: 1 }]);
  });

  it("재고 3권에 주문 8건이 동시에 1권씩 예약하면 정확히 3건만 성공하고 예약 합계가 재고를 넘지 않는다", async () => {
    await seedStock(5, 3);
    const orders = [];
    for (let i = 0; i < 8; i++) orders.push(await confirmedOrder(5, 1));
    const api = createPgStockApi({ pool: db.pool() });

    const results = await Promise.allSettled(orders.map((o) => api.reserveStock(owner, reserveBody(o, 1))));

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason as AppError);
    expect(ok).toBe(3);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((e) => e.code === "BUSINESS_INVARIANT")).toBe(true);
    expect(await query("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservations where book_key = $1", [BOOK(5)])).toEqual([{ n: 3 }]);
  });

  it("같은 품목 2권에 대해 2권씩 두 번 동시에 예약하면 품목 미배정량 한도로 하나만 성공한다", async () => {
    await seedStock(6, 10);
    const o = await confirmedOrder(6, 2);
    const api = createPgStockApi({ pool: db.pool() });

    const results = await Promise.allSettled([api.reserveStock(owner, reserveBody(o, 2)), api.reserveStock(owner, reserveBody(o, 2))]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await query("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservations where order_line_id = $1", [o.lineId])).toEqual([{ n: 2 }]);
  });

  it("같은 멱등 키로 동시에 예약해도 예약은 하나만 생기고 두 호출이 같은 결과를 받는다", async () => {
    await seedStock(7, 4);
    const o = await confirmedOrder(7, 2);
    const body = reserveBody(o, 2);

    const [x, y] = await Promise.all([
      createPgStockApi({ pool: db.pool() }).reserveStock(owner, body),
      createPgStockApi({ pool: db.pool() }).reserveStock(owner, body),
    ]);

    expect(x.id).toBe(y.id);
    expect(await query("select count(*)::int as n from public.ordering_stock_reservations where order_line_id = $1", [o.lineId])).toEqual([{ n: 1 }]);
  });
});

describe("재고 원장 DB 불변식 (어댑터를 거치지 않는 쓰기도 지킨다)", () => {
  it("원장은 추가 전용이다: 예약·이동 기록의 UPDATE·DELETE는 서버 역할도 P0001로 거부된다", async () => {
    await seedStock(8, 2);
    const o = await confirmedOrder(8, 1);
    await createPgStockApi({ pool: db.pool() }).reserveStock(owner, reserveBody(o, 1));
    const c = await db.connect();
    try {
      for (const sql of [
        "update public.ordering_stock_reservations set quantity = 99",
        "delete from public.ordering_stock_reservations",
        "update public.ordering_stock_movements set quantity = 99",
        "delete from public.ordering_stock_movements",
      ]) {
        expect(await sqlState(() => c.query(sql)), sql).toBe("P0001");
      }
    } finally {
      await c.end();
    }
  });

  it("SQL로 직접 넣어도 가용 재고를 넘는 예약은 트리거가 거부하고, 두 세션이 마지막 1권을 동시에 직접 넣으면 하나만 들어간다", async () => {
    await seedStock(9, 1);
    const [o1, o2] = [await confirmedOrder(9, 1), await confirmedOrder(9, 1)];
    const insert = (o: { orderId: string; lineId: string }, qty: number) =>
      `insert into public.ordering_stock_reservations (tenant_id, book_key, order_id, order_line_id, quantity, reserved_by, reserved_at)
       values ('${T_A}', '${BOOK(9)}', '${o.orderId}', '${o.lineId}', ${qty}, 'raw', now())`;
    const a = await db.connect();
    const b = await db.connect();
    try {
      expect(await sqlState(() => a.query(insert(o1, 2)))).toBe("P0001"); // 재고 1권 초과
      await a.query("begin");
      await b.query("begin");
      await a.query(insert(o1, 1));
      const second = sqlState(() => b.query(insert(o2, 1))); // a가 커밋할 때까지 락에서 대기
      await a.query("commit");
      expect(await second).toBe("P0001");
      await b.query("rollback");
      expect(await query("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservations where book_key = $1", [BOOK(9)])).toEqual([{ n: 1 }]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("다른 책의 품목에 예약을 붙이거나 다른 서점의 주문을 가리키는 예약은 거부된다 (책 키 불일치·복합 FK)", async () => {
    await seedStock(10, 5);
    const o = await confirmedOrder(10, 1);
    const c = await db.connect();
    try {
      const raw = (tenant: string, book: string) =>
        sqlState(() =>
          c.query(
            `insert into public.ordering_stock_reservations (tenant_id, book_key, order_id, order_line_id, quantity, reserved_by, reserved_at)
             values ('${tenant}', '${book}', '${o.orderId}', '${o.lineId}', 1, 'raw', now())`,
          ),
        );
      expect(await raw(T_A, BOOK(11))).toBe("P0001");
      expect(await raw(T_B, BOOK(10))).toBe("23503");
    } finally {
      await c.end();
    }
  });

  it("재고·예약 읽기는 같은 서점의 활성 멤버만 가능하고 anon은 42501, 클라이언트의 직접 쓰기는 42501이다", async () => {
    await seedStock(12, 2);
    const c = await db.connect();
    try {
      const count = (sub: string, table: string) =>
        withJwt(c, { role: "authenticated", claims: { sub } }, async () => (await c.query(`select count(*)::int as n from public.${table}`)).rows[0].n);
      expect(await count(OWNER_A, "ordering_stock_movements")).toBeGreaterThan(0);
      expect(await count(STAFF_A, "ordering_stock_reservations")).toBeGreaterThan(0);
      expect(await count(OWNER_B, "ordering_stock_movements")).toBe(0);
      expect(await count(STRANGER, "ordering_stock_reservations")).toBe(0);
      expect(await count(EX_STAFF_A, "ordering_stock_movements")).toBe(0);
      expect(await withJwt(c, { role: "anon", claims: null }, () => sqlState(() => c.query("select * from public.ordering_stock_movements")))).toBe("42501");
      expect(
        await withJwt(c, { role: "authenticated", claims: { sub: OWNER_A } }, () =>
          sqlState(() =>
            c.query(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ('${T_A}', 'x', 'ADJUST', 'IN', 1, 'r', 'a', now())`),
          ),
        ),
      ).toBe("42501");
    } finally {
      await c.end();
    }
  });
});
