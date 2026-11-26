import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** O-09-04 환급 필요 업무: 서점 전체 환급 업무 목록(파생 상태·남은 금액·미결 요청·미해소 시도). 증빙·사유 원문은 싣지 않는다 */
const T = "aaaaaaaa-0000-4000-8000-0000000000c9";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000ca";
const OWNER = "11111111-0000-4000-8000-0000000000c9";
const STAFF = "11111111-0000-4000-8000-0000000000cb";
const EX_STAFF = "11111111-0000-4000-8000-0000000000cc";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000ca";
const STRANGER = "99999999-0000-4000-8000-0000000000c9";
const day = (n: number) => `2026-03-0${n}T00:00:00.000Z`;

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const reads = () => createPgReadApi({ pool: db.pool() });
const owner = () => ({ userId: OWNER });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const ids: Record<string, string> = {};
let seq = 0;

async function confirmedOrder(tenant: string, displayNumber: number) {
  return (await q(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ($1, 'CONFIRMED', $2, 100000) returning id`, [tenant, displayNumber]))[0].id as string;
}
async function confirmedPayment(tenant: string, orderId: string, amount = 100000) {
  const id = (await q(`insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ($1, $2, 'BANK_TRANSFER', $3, $4, now(), 'u') returning id`, [tenant, orderId, amount, `EXT-${++seq}`]))[0].id as string;
  await q(`insert into public.ordering_payment_confirmations (tenant_id, payment_id, evidence, confirmed_by, confirmed_at) values ($1, $2, '입금 확인', 'u', now())`, [tenant, id]);
  return id;
}
const task = async (key: string, tenant: string, orderId: string, required: number, openedAt: string) => {
  ids[key] = (await q(`insert into public.ordering_refund_tasks (tenant_id, order_id, required_krw, opened_by, opened_at) values ($1, $2, $3, 'u', $4) returning id`, [tenant, orderId, required, openedAt]))[0].id as string;
};
const confirmRefund = (taskKey: string, orderId: string, paymentId: string, amount: number) =>
  q(`insert into public.ordering_refund_confirmations (tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, confirmed_by, confirmed_at) values ($1, $2, $3, $4, $5, '비밀 환급 증빙', 'u', now())`, [T, ids[taskKey], orderId, paymentId, amount]);

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);

  // R1: 10000 필요, 아직 환급 없음 + 미결 요청 1(승인 대기) + 거절된 요청 1
  const o1 = await confirmedOrder(T, 1);
  const p1 = await confirmedPayment(T, o1);
  await task("R1", T, o1, 10000, day(1));
  const pending = (await q(`insert into public.ordering_refund_requests (tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, requested_by, requested_at) values ($1, $2, $3, $4, 3000, '비밀 요청 증빙', 'u', now()) returning id`, [T, ids.R1, o1, p1]))[0].id as string;
  const rejected = (await q(`insert into public.ordering_refund_requests (tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, requested_by, requested_at) values ($1, $2, $3, $4, 2000, '증빙', 'u', now()) returning id`, [T, ids.R1, o1, p1]))[0].id as string;
  await q(`insert into public.ordering_refund_request_decisions (tenant_id, request_id, kind, decided_by, decided_at) values ($1, $2, 'REJECTED', 'u', now())`, [T, rejected]);
  void pending;
  // R2: 20000 필요, 5000 환급(일부) + 미해소 불명확 시도 1 + 해소된 시도 1
  const o2 = await confirmedOrder(T, 2);
  const p2 = await confirmedPayment(T, o2);
  await task("R2", T, o2, 20000, day(2));
  await confirmRefund("R2", o2, p2, 5000);
  await q(`insert into public.ordering_refund_attempts (tenant_id, refund_task_id, order_id, payment_id, amount_krw, result, reason, reported_by, reported_at) values ($1, $2, $3, $4, 4000, 'UNKNOWN', '이체 결과 불명', 'u', now())`, [T, ids.R2, o2, p2]);
  const resolved = (await q(`insert into public.ordering_refund_attempts (tenant_id, refund_task_id, order_id, payment_id, amount_krw, result, reason, reported_by, reported_at) values ($1, $2, $3, $4, 1000, 'UNKNOWN', '불명', 'u', now()) returning id`, [T, ids.R2, o2, p2]))[0].id as string;
  await q(`insert into public.ordering_refund_attempt_resolutions (tenant_id, attempt_id, outcome, evidence, resolved_by, resolved_at) values ($1, $2, 'FAILED', '실패 확인', 'u', now())`, [T, resolved]);
  // R3: 3000 필요, 전액 환급(완료)
  const o3 = await confirmedOrder(T, 3);
  const p3 = await confirmedPayment(T, o3);
  await task("R3", T, o3, 3000, day(3));
  await confirmRefund("R3", o3, p3, 3000);
  // 다른 서점
  const other = await confirmedOrder(OTHER_T, 1);
  await task("OTHER", OTHER_T, other, 1000, day(4));
}, 240_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("환급 필요 업무 목록 (O-09-04)", () => {
  it("서점의 환급 업무를 최신 개시 순으로 파생 상태·남은 금액·미결 요청·미해소 시도와 함께 보여 준다", async () => {
    const page = await reads().listRefundTasks({ userId: STAFF }, { tenantId: T });
    expect(page.items.map((i) => i.id)).toEqual([ids.R3, ids.R2, ids.R1]);
    const by = Object.fromEntries(page.items.map((i) => [i.id, i]));
    expect(by[ids.R1!]).toEqual({
      id: ids.R1, orderId: expect.any(String), orderDisplayNumber: 1, requiredKrw: "10000", refundedKrw: "0", remainingKrw: "10000", status: "REFUND_REQUIRED",
      openedAt: day(1), pendingRequests: 1, unresolvedAttempts: 0,
    });
    expect(by[ids.R2!]).toMatchObject({ requiredKrw: "20000", refundedKrw: "5000", remainingKrw: "15000", status: "PARTIAL", pendingRequests: 0, unresolvedAttempts: 1 });
    expect(by[ids.R3!]).toMatchObject({ refundedKrw: "3000", remainingKrw: "0", status: "REFUNDED" });
    expect(page.items.some((i) => i.id === ids.OTHER)).toBe(false);
    expect(JSON.stringify(page)).not.toMatch(/비밀/);
  });

  it("status 필터와 커서 페이지네이션이 동작한다(필터 뒤에도 커서가 이어진다)", async () => {
    const byStatus = async (status: string) => (await reads().listRefundTasks(owner(), { tenantId: T, status: status as never })).items.map((i) => i.id);
    expect(await byStatus("REFUND_REQUIRED")).toEqual([ids.R1]);
    expect(await byStatus("PARTIAL")).toEqual([ids.R2]);
    expect(await byStatus("REFUNDED")).toEqual([ids.R3]);
    expect((await reads().listRefundTasks(owner(), { tenantId: T, open: true })).items.map((i) => i.id)).toEqual([ids.R2, ids.R1]); // 완료되지 않은 업무만

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reads().listRefundTasks(owner(), { tenantId: T, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([ids.R3, ids.R2, ids.R1]);
    const open = await reads().listRefundTasks(owner(), { tenantId: T, open: true, limit: 1 });
    expect((await reads().listRefundTasks(owner(), { tenantId: T, open: true, limit: 1, cursor: open.nextCursor })).items.map((i) => i.id)).toEqual([ids.R1]);
  });

  it("잘못된 limit·cursor·status·open은 VALIDATION_ERROR, 비멤버·비활성은 FORBIDDEN(검증보다 먼저), 다른 서점 업무는 그 서점에서만 보인다", async () => {
    for (const bad of [{ limit: 0 }, { cursor: "%%%" }, { status: "DONE" as never }, { open: "yes" as never }]) {
      expect(await codeOf(() => reads().listRefundTasks(owner(), { tenantId: T, ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().listRefundTasks({ userId }, { tenantId: T, limit: 0 })), userId).toBe("FORBIDDEN");
    expect((await reads().listRefundTasks({ userId: OTHER_OWNER }, { tenantId: OTHER_T })).items.map((i) => i.id)).toEqual([ids.OTHER]);
  });
});
