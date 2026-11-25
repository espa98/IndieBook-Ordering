import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgNotificationApi } from "../../src/db/pgNotificationApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($4, $5, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, T_B, OWNER_B],
  );
  for (let n = 1; n <= 30; n++) {
    await c.query(
      `insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, $3, 10000, 'MANUAL', '시험', 'seed', now())`,
      [BOOK(n), T_A, `책 ${n}`],
    );
  }
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const staff = { userId: STAFF_A };
let seq = 0;
let bookSeq = 0;
const key = () => `n-${++seq}`;
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
const api = () => createPgNotificationApi({ pool: db.pool() });
const at = () => new Date().toISOString();

/** 책 한 권을 쓰는 확정 주문을 만들고 재고를 시드한다(책은 시험마다 새로 쓴다) */
async function scene(orderedQuantity: number, stock = 10) {
  const book = BOOK(++bookSeq);
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: book, quantity: orderedQuantity, unitPriceKrw: "10000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  await rows(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', $3, '초기 재고', 'seed', now())`, [T_A, book, stock]);
  const lineId = order.lines[0]!.lineId;
  const reserve = (quantity: number) => createPgStockApi({ pool: db.pool() }).reserveStock(owner, { tenantId: T_A, orderId: order.id, orderLineId: lineId, quantity, reservedAt: at(), idempotencyKey: key() });
  return { orderId: order.id, lineId, reserve };
}
const createTarget = (orderId: string, mode?: "FULL" | "PARTIAL", actor = staff, tenantId = T_A) =>
  api().createNotificationTarget(actor, { tenantId, orderId, ...(mode ? { mode } : {}), createdAt: at(), idempotencyKey: key() });

describe("고객 안내 대상 생성 (Postgres 영속화)", () => {
  it("확보 스냅샷으로 대상을 만들고(전체·부분 규칙), 같은 확보량의 중복·비멤버·없는 주문은 거부된다", async () => {
    const s = await scene(3);
    expect(await codeOf(() => createTarget(s.orderId, "PARTIAL"))).toBe("BUSINESS_INVARIANT"); // 확보량 없음
    await s.reserve(1);
    expect(await codeOf(() => createTarget(s.orderId, "FULL"))).toBe("BUSINESS_INVARIANT"); // 전부 확보되지 않음
    expect(await codeOf(() => createTarget(s.orderId, "PARTIAL", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => createTarget("0a000000-0000-4000-8000-00000000ffff", "PARTIAL"))).toBe("NOT_FOUND");

    const partial = await createTarget(s.orderId, "PARTIAL");
    expect(partial).toMatchObject({ orderId: s.orderId, mode: "PARTIAL", securedTotal: 1, createdBy: STAFF_A });
    expect(partial.lines).toEqual([{ orderLineId: s.lineId, orderedQuantity: 3, receivedQuantity: 0, securedQuantity: 1 }]);
    expect(await codeOf(() => createTarget(s.orderId, "PARTIAL"))).toBe("BUSINESS_INVARIANT"); // 같은 확보 스냅샷

    await s.reserve(2); // 확보량이 바뀌면 새 대상이 가능하다
    const full = await createTarget(s.orderId); // 기본 FULL
    expect(full).toMatchObject({ mode: "FULL", securedTotal: 3 });
    expect((await rows("select mode, secured_total::int as total, lines from public.ordering_notification_targets where id = $1", [full.id]))[0]).toMatchObject({ mode: "FULL", total: 3 });
  });
});

describe("문구 복사·발송 시도 (Postgres 영속화)", () => {
  const copy = (targetId: string, action = "COPY", actor = staff) => api().recordNotificationCopy(actor, { tenantId: T_A, targetId, action: action as never, actedAt: at(), idempotencyKey: key() });
  const attempt = (targetId: string, actor = staff, over: Record<string, unknown> = {}) =>
    api().recordNotificationAttempt(actor, { tenantId: T_A, targetId, channel: "PHONE", messageSnapshot: "주문하신 책이 입고되었습니다.", attemptedAt: at(), idempotencyKey: key(), ...over } as never);

  it("복사·미리보기는 여러 번 기록되어도 상태를 바꾸지 않고, 시도는 대상당 한 번이며 확보량이 바뀐 대상은 거부된다", async () => {
    const s = await scene(2);
    await s.reserve(2);
    const target = await createTarget(s.orderId);

    expect(await codeOf(() => copy(target.id, "PRINT"))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => copy(target.id, "COPY", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => copy("0a000000-0000-4000-8000-00000000ffff"))).toBe("NOT_FOUND");
    expect((await copy(target.id, "PREVIEW")).action).toBe("PREVIEW");
    expect((await copy(target.id, "SHARE")).actedBy).toBe(STAFF_A);
    expect((await rows("select count(*)::int as n from public.ordering_notification_copies where target_id = $1", [target.id]))[0].n).toBe(2);
    expect((await rows("select count(*)::int as n from public.ordering_notification_attempts where target_id = $1", [target.id]))[0].n).toBe(0); // 복사는 발송이 아니다

    expect(await codeOf(() => attempt(target.id, staff, { channel: "FAX" }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => attempt(target.id, staff, { messageSnapshot: " " }))).toBe("VALIDATION_ERROR");
    const made = await attempt(target.id);
    expect(made).toMatchObject({ targetId: target.id, channel: "PHONE", attemptedBy: STAFF_A, messageSnapshot: "주문하신 책이 입고되었습니다." });
    expect(await codeOf(() => attempt(target.id))).toBe("BUSINESS_INVARIANT"); // 대상당 시도 1회

    const stale = await scene(2);
    await stale.reserve(1);
    const staleTarget = await createTarget(stale.orderId, "PARTIAL");
    await stale.reserve(1); // 확보량이 바뀌었다
    expect(await codeOf(() => attempt(staleTarget.id))).toBe("BUSINESS_INVARIANT"); // obsolete
  });
});

describe("안내 결과·재안내 (Postgres 영속화)", () => {
  const attempt = (targetId: string) => api().recordNotificationAttempt(staff, { tenantId: T_A, targetId, channel: "SMS", messageSnapshot: "입고 안내", attemptedAt: at(), idempotencyKey: key() } as never);
  const result = (attemptId: string, outcome: string, actor = staff) => api().recordNotificationResult(actor, { tenantId: T_A, attemptId, outcome: outcome as never, note: "통화 확인", resultAt: at(), idempotencyKey: key() });
  const renotify = (targetId: string, actor = staff) => api().renotify(actor, { tenantId: T_A, targetId, createdAt: at(), idempotencyKey: key() });

  it("결과는 시도당 한 번이고, 실패한 안내만 한 번 재안내되며 원 대상·시도·결과는 보존된다", async () => {
    const s = await scene(2);
    await s.reserve(2);
    const target = await createTarget(s.orderId);
    expect(await codeOf(() => renotify(target.id))).toBe("BUSINESS_INVARIANT"); // 시도 전에는 재안내 불가
    const made = await attempt(target.id);

    expect(await codeOf(() => result(made.id, "READ"))).toBe("VALIDATION_ERROR"); // 수신·읽음은 저장하지 않는다
    expect(await codeOf(() => result(made.id, "FAILED", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => result("0a000000-0000-4000-8000-00000000ffff", "FAILED"))).toBe("NOT_FOUND");
    const failed = await result(made.id, "FAILED");
    expect(failed).toMatchObject({ targetId: target.id, attemptId: made.id, outcome: "FAILED", recordedBy: STAFF_A });
    expect(await codeOf(() => result(made.id, "MANUAL_RECORDED"))).toBe("BUSINESS_INVARIANT"); // 시도당 결과 1회

    const next = await renotify(target.id);
    expect(next).toMatchObject({ orderId: s.orderId, renoticeOfTargetId: target.id, mode: "FULL", createdBy: STAFF_A });
    expect(next.id).not.toBe(target.id);
    expect(await codeOf(() => renotify(target.id))).toBe("BUSINESS_INVARIANT"); // 이미 재안내됨
    expect((await rows("select count(*)::int as n from public.ordering_notification_attempts where target_id = $1", [target.id]))[0].n).toBe(1); // 원 시도 보존
    expect((await rows("select outcome from public.ordering_notification_results where target_id = $1", [target.id]))[0].outcome).toBe("FAILED");

    const second = await attempt(next.id); // 재안내 대상으로 다시 시도할 수 있다
    expect((await result(second.id, "MANUAL_RECORDED")).outcome).toBe("MANUAL_RECORDED");
    expect(await codeOf(() => renotify(next.id))).toBe("BUSINESS_INVARIANT"); // 성공한 안내는 재안내하지 않는다
  });

  it("같은 시도의 결과·같은 대상의 재안내를 동시에 기록해도 하나만 성공하고, 직접 SQL로도 중복·수정은 막힌다", async () => {
    const s = await scene(2);
    await s.reserve(2);
    const target = await createTarget(s.orderId);
    const made = await attempt(target.id);
    const results = await Promise.allSettled([result(made.id, "FAILED"), result(made.id, "MANUAL_RECORDED")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await rows("select count(*)::int as n from public.ordering_notification_results where attempt_id = $1", [made.id]))[0].n).toBe(1);

    const failedTarget = await scene(2);
    await failedTarget.reserve(2);
    const t2 = await createTarget(failedTarget.orderId);
    await result((await attempt(t2.id)).id, "FAILED");
    const renotices = await Promise.allSettled([renotify(t2.id), renotify(t2.id), renotify(t2.id)]);
    expect(renotices.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await rows("select count(*)::int as n from public.ordering_notification_targets where renotice_of_target_id = $1", [t2.id]))[0].n).toBe(1);

    const c = await db.connect();
    try {
      expect(await sqlState(() => c.query(`insert into public.ordering_notification_results (tenant_id, target_id, attempt_id, outcome, note, recorded_by, result_at) select tenant_id, target_id, id, 'FAILED', 'x', 'raw', now() from public.ordering_notification_attempts where id = '${made.id}'`))).toBe("23505");
      expect(await sqlState(() => c.query(`update public.ordering_notification_results set note = 'x' where attempt_id = '${made.id}'`))).toBe("P0001");
      expect(await sqlState(() => c.query(`delete from public.ordering_notification_attempts where id = '${made.id}'`))).toBe("P0001");
    } finally {
      await c.end();
    }
  });
});
