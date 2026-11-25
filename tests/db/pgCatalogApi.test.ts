import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCatalogApi } from "../../src/db/pgCatalogApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($4, $5, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, T_B, OWNER_B],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const staff = { userId: STAFF_A };
let seq = 0;
const key = () => `bk-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const api = () => createPgCatalogApi({ pool: db.pool() });
const now = () => new Date().toISOString();
const manual = (over: Record<string, unknown> = {}) => ({
  tenantId: T_A,
  source: "MANUAL" as const,
  title: "독립출판 에세이",
  authors: ["김작가"],
  listPriceKrw: "15000",
  reason: "독립출판물",
  registeredAt: now(),
  idempotencyKey: key(),
  ...over,
});

describe("도서 등록 (Postgres 영속화)", () => {
  it("Owner·직원이 수기 도서를 등록하면 행위자가 기록되고, 비멤버·검증 오류는 거부된다", async () => {
    expect(await codeOf(() => api().registerBook({ userId: STRANGER }, manual()))).toBe("FORBIDDEN");
    expect(await codeOf(() => api().registerBook(owner, manual({ title: " " })))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api().registerBook(owner, manual({ reason: undefined })))).toBe("VALIDATION_ERROR");

    const book = await api().registerBook(staff, manual({ isbn: "978-89-0000-000-1" }));
    expect(book).toMatchObject({ tenantId: T_A, title: "독립출판 에세이", isbn: "9788900000001", source: "MANUAL", version: 1, createdBy: STAFF_A });
    const stored = (await rows("select title, isbn, list_price_krw::text as price, manual_reason, created_by from public.ordering_books where id = $1", [book.id]))[0];
    expect(stored).toEqual({ title: "독립출판 에세이", isbn: "9788900000001", price: "15000", manual_reason: "독립출판물", created_by: STAFF_A });
  });
});

describe("도서 중복·멱등·동시성", () => {
  it("같은 ISBN은 확인 없이는 거부되고 확인하면 별도 도서로 등록되며, 같은 멱등 키는 같은 도서를 돌려준다", async () => {
    const first = await api().registerBook(owner, manual({ isbn: "9788900000002" }));
    expect(await codeOf(() => api().registerBook(owner, manual({ isbn: "978-89-0000-000-2" })))).toBe("BUSINESS_INVARIANT");
    const second = await api().registerBook(owner, manual({ isbn: "9788900000002", acknowledgeDuplicateOf: first.id }));
    expect(second.id).not.toBe(first.id);

    const request = manual({ title: "재시도 도서" });
    const a = await api().registerBook(owner, request);
    const b = await api().registerBook(owner, request);
    expect(b.id).toBe(a.id);
    expect((await rows("select count(*)::int as n from public.ordering_books where title = '재시도 도서'"))[0].n).toBe(1);
    expect(await codeOf(() => api().registerBook(owner, { ...request, title: "다른 제목" }))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("같은 ISBN을 여러 세션이 동시에 등록하면 하나만 성공한다", async () => {
    const shared = createPgCatalogApi({ pool: db.pool() });
    await Promise.all(Array.from({ length: 6 }, () => rows("select 1"))); // 연결을 미리 데운다
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => shared.registerBook(owner, manual({ isbn: "9788900000003" }))));
    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "BUSINESS_INVARIANT", "BUSINESS_INVARIANT", "BUSINESS_INVARIANT", "BUSINESS_INVARIANT", "OK"]);
    expect((await rows("select count(*)::int as n from public.ordering_books where isbn = '9788900000003'"))[0].n).toBe(1);
  });
});

describe("중복 확인 표시는 uuid 형식의 도서 ID여야 한다 (Postgres 영속화)", () => {
  it("uuid가 아닌 acknowledgeDuplicateOf는 중복 후보가 없어도 VALIDATION_ERROR이고 등록·수정되지 않는다(조용히 무시하지 않는다)", async () => {
    const count = async () => Number((await db.pool().query("select count(*)::int as n from public.ordering_books where tenant_id = $1", [T_A])).rows[0].n);
    const before = await count();

    expect(await codeOf(() => api().registerBook(owner, manual({ acknowledgeDuplicateOf: "not-a-uuid" })))).toBe("VALIDATION_ERROR");
    expect(await count()).toBe(before);

    const book = await api().registerBook(owner, manual({ title: "확인 표시 대상", isbn: "9788900000777" }));
    const update = (over: Record<string, unknown>) =>
      api().updateBook(owner, { tenantId: T_A, bookId: book.id, expectedVersion: 1, changes: { title: "수정" }, reason: "r", changedAt: now(), idempotencyKey: key(), ...over } as any);
    expect(await codeOf(() => update({ acknowledgeDuplicateOf: "not-a-uuid" }))).toBe("VALIDATION_ERROR");
    expect((await db.pool().query("select version::int as v from public.ordering_books where id = $1", [book.id])).rows[0].v).toBe(1); // 버전이 오르지 않았다
    // uuid 형식이면(없는 도서의 ID라도) 형식은 통과한다. 후보가 없으면 값은 쓰이지 않는다
    expect((await update({ acknowledgeDuplicateOf: "0a000000-0000-4000-8000-0000000000ee" })).version).toBe(2);
  });

  it("권한(403)과 다른 입력 검증(400)이 이 검증보다 먼저이고, 도서가 없으면 404가 먼저다", async () => {
    expect(await codeOf(() => api().registerBook({ userId: STRANGER }, manual({ acknowledgeDuplicateOf: "not-a-uuid" })))).toBe("FORBIDDEN");
    expect(await codeOf(() => api().registerBook(owner, manual({ title: " ", acknowledgeDuplicateOf: "not-a-uuid" })))).toBe("VALIDATION_ERROR"); // 둘 다 틀렸으면 먼저 닿는 검증
    const missing = "0a000000-0000-4000-8000-0000000000dd";
    expect(await codeOf(() => api().updateBook(owner, { tenantId: T_A, bookId: missing, expectedVersion: 1, changes: { title: "x" }, reason: "r", changedAt: now(), idempotencyKey: key(), acknowledgeDuplicateOf: "not-a-uuid" } as any))).toBe("NOT_FOUND");
  });
});

describe("도서 수정 (Postgres 영속화)", () => {
  const update = (bookId: string, expectedVersion: number, changes: Record<string, unknown>, actor = owner, over: Record<string, unknown> = {}) =>
    api().updateBook(actor, { tenantId: T_A, bookId, expectedVersion, changes, reason: "정가 인상", changedAt: now(), idempotencyKey: key(), ...over } as any);

  it("수정하면 버전이 오르고 수정 전 값이 추가 전용 이력에 남으며, 오래된 버전·없는 도서·다른 서점은 거부된다", async () => {
    const book = await api().registerBook(owner, manual({ title: "수정 대상", listPriceKrw: "10000" }));
    expect(await codeOf(() => update(book.id, 1, { listPriceKrw: "12000" }, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => update(book.id, 1, { listPriceKrw: "0" }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => update("0a000000-0000-4000-8000-00000000ffff", 1, { title: "x" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => update(book.id, 7, { title: "x" }))).toBe("VERSION_CONFLICT");

    const updated = await update(book.id, 1, { listPriceKrw: "12000", title: "수정된 제목" }, staff);
    expect(updated).toMatchObject({ id: book.id, version: 2, title: "수정된 제목", listPriceKrw: "12000", source: "MANUAL", createdBy: OWNER_A });
    expect((await rows("select title, list_price_krw::text as price, version::int as v from public.ordering_books where id = $1", [book.id]))[0]).toEqual({ title: "수정된 제목", price: "12000", v: 2 });
    const revision = (await rows("select * from public.ordering_book_revisions where book_id = $1", [book.id]))[0];
    expect(revision).toMatchObject({ version_before: "1", version_after: "2", reason: "정가 인상", changed_by: STAFF_A });
    expect(revision.before).toMatchObject({ title: "수정 대상", listPriceKrw: "10000" });
    expect(revision.after).toMatchObject({ title: "수정된 제목", listPriceKrw: "12000" });
    expect(await codeOf(() => update(book.id, 1, { title: "again" }))).toBe("VERSION_CONFLICT"); // 이미 올라간 버전
    await expect(rows("update public.ordering_book_revisions set reason = 'x' where book_id = $1", [book.id])).rejects.toThrow(); // 추가 전용
  });

  it("같은 버전을 두 세션이 동시에 수정하면 하나만 성공하고, 수정으로 다른 도서와 ISBN이 겹치면 확인 없이는 거부된다", async () => {
    const book = await api().registerBook(owner, manual({ title: "경쟁 수정" }));
    const results = await Promise.allSettled([update(book.id, 1, { title: "가" }), update(book.id, 1, { title: "나" })]);
    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["OK", "VERSION_CONFLICT"]);
    expect((await rows("select count(*)::int as n from public.ordering_book_revisions where book_id = $1", [book.id]))[0].n).toBe(1);

    const other = await api().registerBook(owner, manual({ isbn: "9788900000004" }));
    expect(await codeOf(() => update(book.id, 2, { isbn: "9788900000004" }))).toBe("BUSINESS_INVARIANT");
    expect((await update(book.id, 2, { isbn: "9788900000004" }, owner, { acknowledgeDuplicateOf: other.id })).isbn).toBe("9788900000004");
  });
});
