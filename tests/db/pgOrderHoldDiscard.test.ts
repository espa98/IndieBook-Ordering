import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

/** 초안 보류·재개(ST-O02)와 폐기(ST-O09): Postgres 영속화, DB 제약, 동시성 */
const T = "aaaaaaaa-0000-4000-8000-000000000009";
const OWNER = "11111111-0000-4000-8000-000000000009";
const STAFF = "11111111-0000-4000-8000-00000000000a";
const EX_STAFF = "11111111-0000-4000-8000-00000000000b";
const STRANGER = "99999999-0000-4000-8000-000000000009";
const BOOK = "b0000000-0000-4000-8000-000000000009";
const PAST = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  await c.query(
    `insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '책', '{}', null, 10000, 'MANUAL', '시험', 'seed', now())`,
    [BOOK, T],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
const key = () => `hd-${++seq}`;
const api = () => createPgOrderApi({ pool: db.pool() });
const owner = { userId: OWNER };
const draft = async () =>
  (await api().createOrder(owner, { tenantId: T, idempotencyKey: key(), lines: [{ bookId: BOOK, quantity: 1, unitPriceKrw: "10000" }] })) as { id: string; version: number };
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
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
const hold = (actor: { userId: string }, orderId: string, expectedVersion: number, extra: Record<string, unknown> = {}) =>
  api().holdOrder(actor, { tenantId: T, orderId, expectedVersion, reason: "입금 확인 중", heldAt: PAST, idempotencyKey: key(), ...extra } as never);
const resume = (actor: { userId: string }, orderId: string, expectedVersion: number) =>
  api().resumeOrder(actor, { tenantId: T, orderId, expectedVersion, resumedAt: PAST, idempotencyKey: key() } as never);
const discard = (actor: { userId: string }, orderId: string, expectedVersion: number) =>
  api().discardOrder(actor, { tenantId: T, orderId, expectedVersion, reason: "고객 철회", discardedAt: PAST, idempotencyKey: key() } as never);
const confirm = (orderId: string, expectedVersion: number) => api().confirmOrder(owner, { tenantId: T, orderId, expectedVersion, idempotencyKey: key() });

describe("초안 보류·재개 (ST-O02, Postgres)", () => {
  it("보류하면 저장되고(담당자는 인증된 사용자), 보류 중에는 확정할 수 없으며, 재개하면 확정할 수 있다", async () => {
    const order = await draft();
    const held = await hold({ userId: STAFF }, order.id, order.version, { heldBy: "위조" });
    expect(held).toMatchObject({ status: "DRAFT", version: 2, heldAt: PAST, holdReason: "입금 확인 중" });
    expect((await rows("select hold_reason, held_by from public.ordering_orders where id = $1", [order.id]))[0]).toMatchObject({ hold_reason: "입금 확인 중", held_by: STAFF });
    expect(await api().getOrder(owner, { tenantId: T, orderId: order.id })).toMatchObject({ heldAt: PAST, holdReason: "입금 확인 중" });

    expect(await codeOf(() => confirm(order.id, 2))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => hold(owner, order.id, 2))).toBe("BUSINESS_INVARIANT");

    const resumed = await resume(owner, order.id, 2);
    expect(resumed.version).toBe(3);
    expect(resumed.heldAt).toBeUndefined();
    expect((await rows("select held_at, hold_reason, held_by from public.ordering_orders where id = $1", [order.id]))[0]).toEqual({ held_at: null, hold_reason: null, held_by: null });
    expect((await confirm(order.id, 3)).status).toBe("CONFIRMED");
  });

  it("비멤버·비활성 직원은 FORBIDDEN이고 아무것도 바뀌지 않으며, 낡은 version은 VERSION_CONFLICT, 같은 멱등 키는 같은 결과", async () => {
    const order = await draft();
    for (const userId of [STRANGER, EX_STAFF]) expect(await codeOf(() => hold({ userId }, order.id, 1))).toBe("FORBIDDEN");
    expect(await codeOf(() => hold(owner, order.id, 7))).toBe("VERSION_CONFLICT");
    expect((await rows("select version, held_at from public.ordering_orders where id = $1", [order.id]))[0]).toEqual({ version: "1", held_at: null });

    const k = key();
    const first = await hold(owner, order.id, 1, { idempotencyKey: k });
    expect(await hold(owner, order.id, 1, { idempotencyKey: k })).toEqual(first);
    expect((await rows("select version from public.ordering_orders where id = $1", [order.id]))[0].version).toBe("2");
  });

  it("같은 초안을 두 연결이 동시에 보류하면 하나만 성공한다", async () => {
    const order = await draft();
    const results = await Promise.all([
      hold(owner, order.id, 1).then(() => "OK", (e) => (e as AppError).code),
      hold({ userId: STAFF }, order.id, 1).then(() => "OK", (e) => (e as AppError).code),
    ]);
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r !== "OK")).toHaveLength(1);
    expect((await rows("select version from public.ordering_orders where id = $1", [order.id]))[0].version).toBe("2");
  });
});

describe("초안 폐기 (ST-O09, Postgres)", () => {
  it("폐기하면 이력(품목·사유)이 보존된 채 저장되고, 이후 보류·재개·확정·재폐기는 거부되며, 보류 중인 초안도 폐기할 수 있다", async () => {
    const order = await draft();
    const held = await hold(owner, order.id, 1);
    const discarded = await discard({ userId: STAFF }, order.id, held.version);
    expect(discarded).toMatchObject({ status: "DRAFT", discardedAt: PAST, discardReason: "고객 철회" });
    const row = (await rows("select held_at, discarded_at, discard_reason, discarded_by from public.ordering_orders where id = $1", [order.id]))[0];
    expect(row).toMatchObject({ held_at: null, discard_reason: "고객 철회", discarded_by: STAFF });
    expect((await rows("select count(*)::int as n from public.ordering_order_lines where order_id = $1", [order.id]))[0].n).toBe(1);

    const v = discarded.version;
    expect(await codeOf(() => discard(owner, order.id, v))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => hold(owner, order.id, v))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => resume(owner, order.id, v))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => confirm(order.id, v))).toBe("BUSINESS_INVARIANT");
  });

  it("확정된 주문은 폐기할 수 없다", async () => {
    const order = await draft();
    await confirm(order.id, 1);
    expect(await codeOf(() => discard(owner, order.id, 2))).toBe("BUSINESS_INVARIANT");
  });

  it("목록 요약에 보류·폐기가 표시된다", async () => {
    const held = await draft();
    await hold(owner, held.id, 1);
    const gone = await draft();
    await discard(owner, gone.id, 1);
    const page = await api().listOrders(owner, { tenantId: T, limit: 100, includeDiscarded: true });
    const byId = Object.fromEntries(page.items.map((i) => [i.id, i as { heldAt?: string; discardedAt?: string }]));
    expect(byId[held.id]?.heldAt).toBe(PAST);
    expect(byId[gone.id]?.discardedAt).toBe(PAST);
  });

  it("DB 제약: 확정 주문은 보류·폐기 표시를 가질 수 없고, 폐기한 주문은 어떤 갱신도 거부하며, 사유 없는 보류·보류와 폐기 동시 표시는 거부한다", async () => {
    const order = await draft();
    const confirmed = await draft();
    await confirm(confirmed.id, 1);
    const c = await db.connect();
    try {
      const run = async (sql: string, params: unknown[]) => sqlState(() => c.query(sql, params));
      expect(await run("update public.ordering_orders set held_at = now(), hold_reason = 'x', held_by = 'u', version = version + 1 where id = $1", [confirmed.id])).toBe("23514");
      expect(await run("update public.ordering_orders set discarded_at = now(), discard_reason = 'x', discarded_by = 'u', version = version + 1 where id = $1", [confirmed.id])).toBe("23514");
      expect(await run("update public.ordering_orders set held_at = now(), version = version + 1 where id = $1", [order.id])).toBe("23514");
      expect(await run("update public.ordering_orders set discarded_at = now(), discard_reason = 'x', discarded_by = 'u', held_at = now(), hold_reason = 'y', held_by = 'u', version = version + 1 where id = $1", [order.id])).toBe("23514");
      await c.query("update public.ordering_orders set discarded_at = now(), discard_reason = '철회', discarded_by = 'u', version = version + 1 where id = $1", [order.id]);
      expect(await run("update public.ordering_orders set discarded_at = null, discard_reason = null, discarded_by = null, version = version + 1 where id = $1", [order.id])).toBe("P0001");
    } finally {
      await c.end();
    }
  });

  it("폐기된 초안은 목록에서 기본 제외되고(페이지는 폐기분을 건너뛰어 채워진다), includeDiscarded를 켜면 나온다", async () => {
    const keep = await draft();
    const gone = await draft();
    await discard(owner, gone.id, 1);
    // 가장 최근 주문 여러 건이 모두 폐기여도 페이지가 폐기분에 막히지 않고 다음 페이지로 이어져야 한다
    for (let i = 0; i < 5; i++) await discard(owner, (await draft()).id, 1);
    const all = [];
    let cursor: string | undefined;
    do {
      const page = await api().listOrders(owner, { tenantId: T, limit: 3, ...(cursor ? { cursor } : {}) });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(all.some((i) => i.id === gone.id)).toBe(false);
    expect(all.some((i) => i.id === keep.id)).toBe(true);
    expect(all.every((i) => (i as { discardedAt?: string }).discardedAt === undefined)).toBe(true);
    const nonDiscardedInDb = (await rows("select count(*)::int as n from public.ordering_orders where tenant_id = $1 and discarded_at is null", [T]))[0].n;
    expect(all.length, "폐기분을 뺀 모든 주문이 페이지를 따라 나와야 한다").toBe(nonDiscardedInDb);

    const withGone = await api().listOrders(owner, { tenantId: T, limit: 100, includeDiscarded: true });
    expect(withGone.items.some((i) => i.id === gone.id)).toBe(true);
    expect(await codeOf(() => api().listOrders(owner, { tenantId: T, includeDiscarded: "yes" as never }))).toBe("VALIDATION_ERROR");
  });
});
