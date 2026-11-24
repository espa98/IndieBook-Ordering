import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK_1 = "b0000000-0000-4000-8000-000000000001";
const BOOK_2 = "b0000000-0000-4000-8000-000000000002";
const BOOK_OTHER_TENANT = "b0000000-0000-4000-8000-0000000000bb";

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
  await c.query(
    `insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values
       ($1, $3, '독립서점 운영기', '{박서점}', '9788960901234', 16800, 'MANUAL', '시험', 'seed', now()),
       ($2, $3, '책방의 오후', '{}', null, 15000, 'MANUAL', '시험', 'seed', now()),
       ($4, $5, '다른 서점의 책', '{}', null, 9000, 'MANUAL', '시험', 'seed', now())`,
    [BOOK_1, BOOK_2, T_A, BOOK_OTHER_TENANT, T_B],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const lines = (bookId = BOOK_1, quantity = 2) => [{ bookId, quantity, unitPriceKrw: "15000" }];
let seq = 0;
const key = () => `k-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const count = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows[0].n as number;
  } finally {
    await c.end();
  }
};

describe("createPgOrderApi: 기존 주문 API를 Postgres 영속화로 실행 (E7 권고안 a)", () => {
  it("주문을 만들면 주문·품목·스냅샷·멱등 기록이 한 트랜잭션으로 저장되고, 새 API 인스턴스(재시작)에서도 조회된다", async () => {
    const api = createPgOrderApi({ pool: db.pool() });

    const created = await api.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: lines(BOOK_1, 2) });

    expect(created).toMatchObject({ status: "DRAFT", version: 1 });
    expect(created.lines[0]).toMatchObject({
      bookId: BOOK_1,
      quantity: 2,
      unitPriceKrw: "15000",
      bookTitle: "독립서점 운영기",
      bookIsbn: "9788960901234",
      listPriceKrw: "16800",
    });
    expect(await count("select count(*)::int as n from public.ordering_order_lines where order_id = $1", [created.id])).toBe(1);

    const restarted = createPgOrderApi({ pool: db.pool() }); // 메모리 상태 없이 DB만으로
    expect(await restarted.getOrder(owner, { tenantId: T_A, orderId: created.id })).toEqual(created);
    expect((await restarted.listOrders(owner, { tenantId: T_A })).items.map((i) => i.id)).toContain(created.id);
  });

  it("같은 멱등 키·같은 본문은 같은 주문을 돌려주고 중복 저장하지 않으며, 같은 키·다른 본문은 IDEMPOTENCY_CONFLICT이다 (재시작 뒤에도)", async () => {
    const k = key();
    const first = await createPgOrderApi({ pool: db.pool() }).createOrder(owner, { tenantId: T_A, idempotencyKey: k, lines: lines(BOOK_2, 1) });
    const retry = await createPgOrderApi({ pool: db.pool() }).createOrder(owner, { tenantId: T_A, idempotencyKey: k, lines: lines(BOOK_2, 1) });

    expect(retry).toEqual(first);
    expect(await count("select count(*)::int as n from public.ordering_orders where id = $1", [first.id])).toBe(1);
    expect(
      await codeOf(() => createPgOrderApi({ pool: db.pool() }).createOrder(owner, { tenantId: T_A, idempotencyKey: k, lines: lines(BOOK_2, 3) })),
    ).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("카탈로그에 없는 도서나 다른 서점의 도서는 VALIDATION_ERROR이고 트랜잭션이 롤백되어 아무것도 저장되지 않는다", async () => {
    const api = createPgOrderApi({ pool: db.pool() });
    const before = await count("select count(*)::int as n from public.ordering_orders");
    const beforeCommands = await count("select count(*)::int as n from public.ordering_commands");

    expect(await codeOf(() => api.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: lines("ghost-book") }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: lines(BOOK_OTHER_TENANT) }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK_1, quantity: 0, unitPriceKrw: "1" }] }))).toBe("VALIDATION_ERROR");

    expect(await count("select count(*)::int as n from public.ordering_orders")).toBe(before);
    expect(await count("select count(*)::int as n from public.ordering_commands")).toBe(beforeCommands);
  });

  it("확정하면 서점별 표시번호가 1부터 순서대로 발급되고, 낡은 version은 VERSION_CONFLICT, 재확정은 BUSINESS_INVARIANT이다", async () => {
    const api = createPgOrderApi({ pool: db.pool() });
    const make = () => api.createOrder({ userId: OWNER_B }, { tenantId: T_B, idempotencyKey: key(), lines: [{ bookId: BOOK_OTHER_TENANT, quantity: 1, unitPriceKrw: "9000" }] });
    const [a, b] = [await make(), await make()];

    const first = await api.confirmOrder({ userId: OWNER_B }, { tenantId: T_B, orderId: a.id, expectedVersion: 1, idempotencyKey: key() });
    const second = await api.confirmOrder({ userId: OWNER_B }, { tenantId: T_B, orderId: b.id, expectedVersion: 1, idempotencyKey: key() });

    expect([first.displayNumber, second.displayNumber]).toEqual([1, 2]);
    expect(first).toMatchObject({ status: "CONFIRMED", version: 2, totalKrw: "9000" });
    expect(await codeOf(() => api.confirmOrder({ userId: OWNER_B }, { tenantId: T_B, orderId: a.id, expectedVersion: 1, idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT");
    const c = await make();
    expect(await codeOf(() => api.confirmOrder({ userId: OWNER_B }, { tenantId: T_B, orderId: c.id, expectedVersion: 9, idempotencyKey: key() }))).toBe("VERSION_CONFLICT");
    // 서점 A의 번호와 독립이다
    const other = await api.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: lines() });
    const confirmedA = await api.confirmOrder(owner, { tenantId: T_A, orderId: other.id, expectedVersion: 1, idempotencyKey: key() });
    expect(confirmedA.displayNumber).toBe(1);
  });

  it("권한: 비멤버·비활성 직원은 FORBIDDEN, 인증 없음은 UNAUTHENTICATED, 다른 서점의 주문 ID는 없는 ID와 같은 NOT_FOUND이다", async () => {
    const api = createPgOrderApi({ pool: db.pool() });
    const mine = await api.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: lines() });

    expect(await codeOf(() => api.createOrder({ userId: STRANGER }, { tenantId: T_A, idempotencyKey: key(), lines: lines() }))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.createOrder({ userId: EX_STAFF_A }, { tenantId: T_A, idempotencyKey: key(), lines: lines() }))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.getOrder({ userId: EX_STAFF_A }, { tenantId: T_A, orderId: mine.id }))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.createOrder({ userId: "" }, { tenantId: T_A, idempotencyKey: key(), lines: lines() }))).toBe("UNAUTHENTICATED");
    expect(await codeOf(() => api.getOrder({ userId: OWNER_B }, { tenantId: T_A, orderId: mine.id }))).toBe("FORBIDDEN"); // A의 멤버가 아니다
    expect(await codeOf(() => api.getOrder({ userId: OWNER_B }, { tenantId: T_B, orderId: mine.id }))).toBe("NOT_FOUND"); // 자기 서점 범위에서는 없다
    expect(await codeOf(() => api.getOrder({ userId: OWNER_B }, { tenantId: T_B, orderId: "0a000000-0000-4000-8000-00000000ffff" }))).toBe("NOT_FOUND");
    expect((await api.getOrder({ userId: STAFF_A }, { tenantId: T_A, orderId: mine.id })).id).toBe(mine.id);
    // 쓰기 경로의 DB 권한 오류가 아니라 도메인 권한이 먼저 판단한다
    expect(await codeOf(() => api.createOrder({ userId: "not-a-uuid" }, { tenantId: T_A, idempotencyKey: key(), lines: lines() }))).toBe("FORBIDDEN");
  });

  it("목록은 최신순이고 상태 필터·커서가 동작하며 다른 서점의 주문은 보이지 않는다", async () => {
    const api = createPgOrderApi({ pool: db.pool() });
    const page1 = await api.listOrders({ userId: OWNER_B }, { tenantId: T_B, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await api.listOrders({ userId: OWNER_B }, { tenantId: T_B, limit: 2, cursor: page1.nextCursor });
    const all = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(all).size).toBe(all.length);
    const drafts = await api.listOrders({ userId: OWNER_B }, { tenantId: T_B, status: "DRAFT", limit: 100 });
    expect(drafts.items.every((i) => i.status === "DRAFT")).toBe(true);
    const aIds = (await api.listOrders(owner, { tenantId: T_A, limit: 100 })).items.map((i) => i.id);
    expect(aIds.some((id) => all.includes(id))).toBe(false);
  });
});

describe("createPgOrderApi: 두 독립 세션의 실제 동시성", () => {
  it("같은 주문을 같은 version으로 동시에 확정하면 하나만 성공하고 진 쪽은 이미 확정된 주문을 보고 BUSINESS_INVARIANT가 된다 (순차 재확정과 같은 규칙)", async () => {
    const apiA = createPgOrderApi({ pool: db.pool() });
    const apiB = createPgOrderApi({ pool: db.pool() });
    const order = await apiA.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: lines() });

    const results = await Promise.allSettled([
      apiA.confirmOrder(owner, { tenantId: T_A, orderId: order.id, expectedVersion: 1, idempotencyKey: key() }),
      apiB.confirmOrder({ userId: STAFF_A }, { tenantId: T_A, orderId: order.id, expectedVersion: 1, idempotencyKey: key() }),
    ]);

    const outcomes = results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();
    expect(outcomes).toEqual(["BUSINESS_INVARIANT", "OK"]); // 행 잠금으로 직렬화되어 진 쪽은 커밋된 CONFIRMED를 읽는다
    expect(await count("select version::int as n from public.ordering_orders where id = $1", [order.id])).toBe(2);
  });

  it("서로 다른 주문을 동시에 확정해도 표시번호가 중복되지 않는다", async () => {
    const api = createPgOrderApi({ pool: db.pool() });
    const orders = await Promise.all([1, 2, 3, 4, 5].map(() => api.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: lines() })));

    const confirmed = await Promise.all(
      orders.map((o) => api.confirmOrder(owner, { tenantId: T_A, orderId: o.id, expectedVersion: 1, idempotencyKey: key() })),
    );

    const numbers = confirmed.map((c) => c.displayNumber as number).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers[4]! - numbers[0]!).toBe(4); // 빈틈 없이 연속
  });

  it("같은 멱등 키로 동시에 주문을 만들면 주문은 하나만 생기고 두 호출이 같은 결과를 받는다", async () => {
    const apiA = createPgOrderApi({ pool: db.pool() });
    const apiB = createPgOrderApi({ pool: db.pool() });
    const k = key();
    const body = { tenantId: T_A, idempotencyKey: k, lines: lines(BOOK_2, 4) };
    const before = await count("select count(*)::int as n from public.ordering_orders where tenant_id = $1", [T_A]);

    const [x, y] = await Promise.all([apiA.createOrder(owner, body), apiB.createOrder(owner, body)]);

    expect(x.id).toBe(y.id);
    expect(await count("select count(*)::int as n from public.ordering_orders where tenant_id = $1", [T_A])).toBe(before + 1);
  });
});
