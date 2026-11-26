import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** O-01 대시보드: 서버 집계(주문·발주·환급·장기 미수령). 숫자는 원장·테이블에서 직접 센다 */
const T = "aaaaaaaa-0000-4000-8000-0000000000e1";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000e2";
const OWNER = "11111111-0000-4000-8000-0000000000e1";
const STAFF = "11111111-0000-4000-8000-0000000000e2";
const EX_STAFF = "11111111-0000-4000-8000-0000000000e3";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000e4";
const STRANGER = "99999999-0000-4000-8000-0000000000e1";
const NOW = new Date("2026-03-10T12:00:00.000Z");

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false), ($5, $6, 'OWNER', true)`,
    [T, OWNER, STAFF, EX_STAFF, OTHER_T, OTHER_OWNER],
  );
  // 주문: 초안 2(하나는 오늘 접수), 보류 1, 폐기 1, 확정 3(하나는 오늘 접수). 다른 서점에도 초안 3
  const order = (tenant: string, status: string, createdAt: string, extra = "") =>
    q(
      `insert into public.ordering_orders (tenant_id, status, created_at ${extra ? ", " + extra.split("|")[0] : ""}) values ($1, $2, $3 ${extra ? ", " + extra.split("|")[1] : ""})`,
      [tenant, status, createdAt],
    );
  await order(T, "DRAFT", "2026-03-10T01:00:00Z");
  await order(T, "DRAFT", "2026-03-08T01:00:00Z");
  await order(T, "DRAFT", "2026-03-09T01:00:00Z", "held_at, hold_reason, held_by|now(), 'x', 'u'");
  await order(T, "DRAFT", "2026-03-09T02:00:00Z", "discarded_at, discard_reason, discarded_by|now(), 'x', 'u'");
  await q(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw, created_at) values ($1, 'CONFIRMED', 1, 1000, '2026-03-10T02:00:00Z'), ($1, 'CONFIRMED', 2, 2000, '2026-03-07T02:00:00Z'), ($1, 'CONFIRMED', 3, 3000, '2026-03-05T02:00:00Z')`, [T]);
  for (let i = 0; i < 3; i++) await order(OTHER_T, "DRAFT", "2026-03-10T03:00:00Z");
  // 발주: 상태별 하나씩
  for (const status of ["DRAFT", "READY", "SENT", "SENT", "ACKNOWLEDGED", "CANCELLED", "CLOSED"]) {
    await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status) values ($1, 'sup', $2)`, [T, status]);
  }
  await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status) values ($1, 'sup', 'SENT')`, [OTHER_T]);
  // 환급 업무 3건: 미환급(10000), 일부 환급(20000 중 5000), 환급 완료(3000 중 3000)
  const confirmedOrders = (await q(`select id from public.ordering_orders where tenant_id = $1 and status = 'CONFIRMED' order by display_number`, [T])).map((r) => r.id as string);
  // 한 주문에는 미완료 환급 업무가 하나뿐이다
  const task = async (orderId: string, required: number) => (await q(`insert into public.ordering_refund_tasks (tenant_id, order_id, required_krw, opened_by, opened_at) values ($1, $2, $3, 'u', now()) returning id`, [T, orderId, required]))[0].id as string;
  const t1 = await task(confirmedOrders[0]!, 10000);
  const t2 = await task(confirmedOrders[1]!, 20000);
  const t3 = await task(confirmedOrders[2]!, 3000);
  const pay = async (orderId: string, ref: string) => {
    const id = (await q(`insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ($1, $2, 'BANK_TRANSFER', 100000, $3, now(), 'u') returning id`, [T, orderId, ref]))[0].id as string;
    await q(`insert into public.ordering_payment_confirmations (tenant_id, payment_id, evidence, confirmed_by, confirmed_at) values ($1, $2, '입금 확인', 'u', now())`, [T, id]);
    return id;
  };
  for (const [taskId, orderId, amount] of [[t2, confirmedOrders[1]!, 5000], [t3, confirmedOrders[2]!, 3000]] as const) {
    await q(
      `insert into public.ordering_refund_confirmations (tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, confirmed_by, confirmed_at) values ($1, $2, $3, $4, $5, '증빙', 'u', now())`,
      [T, taskId, orderId, await pay(orderId, `EXT-${amount}`), amount],
    );
  }
  void t1;
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const reads = () => createPgReadApi({ pool: db.pool(), now: () => NOW });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};

describe("대시보드 집계 (O-01)", () => {
  it("주문·발주·환급 업무를 서점 범위로 센다(초안은 보류·폐기를 따로 센다, 다른 서점은 섞이지 않는다)", async () => {
    const dashboard = await reads().getDashboard({ userId: STAFF }, { tenantId: T });
    expect(dashboard.orders).toEqual({ draft: 2, held: 1, discarded: 1, confirmed: 3 });
    expect(dashboard.purchaseOrders).toEqual({ draft: 1, ready: 1, sent: 2, acknowledged: 1 });
    expect(dashboard.refunds).toEqual({ required: 1, partial: 1, remainingKrw: "25000" });
    expect(dashboard.longUnreceivedWarnings).toBe(0);
  });

  it("since를 주면 그 시각 이후 접수된 주문 수(폐기 제외)를 함께 돌려준다", async () => {
    expect((await reads().getDashboard({ userId: OWNER }, { tenantId: T })).receivedSince).toBeUndefined();
    const today = await reads().getDashboard({ userId: OWNER }, { tenantId: T, since: "2026-03-10T00:00:00.000Z" });
    expect(today.receivedSince).toBe(2); // 오늘 접수: 초안 1 + 확정 1
    const week = await reads().getDashboard({ userId: OWNER }, { tenantId: T, since: "2026-03-08T00:00:00.000Z" });
    expect(week.receivedSince).toBe(4); // 03-08 초안, 03-09 보류 초안, 03-10 초안·확정 (폐기 제외)
    for (const bad of ["2026-03-10", "어제", "2026-03-10T00:00:00+09:00", "2027-01-01T00:00:00.000Z"]) {
      expect(await codeOf(() => reads().getDashboard({ userId: OWNER }, { tenantId: T, since: bad })), bad).toBe("VALIDATION_ERROR");
    }
  });

  it("활성 멤버만 볼 수 있다(비멤버·비활성·다른 서점 Owner는 FORBIDDEN), 다른 서점 숫자는 그 서점 것이다", async () => {
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().getDashboard({ userId }, { tenantId: T })), userId).toBe("FORBIDDEN");
    const theirs = await reads().getDashboard({ userId: OTHER_OWNER }, { tenantId: OTHER_T });
    expect(theirs.orders).toEqual({ draft: 3, held: 0, discarded: 0, confirmed: 0 });
    expect(theirs.purchaseOrders).toEqual({ draft: 0, ready: 0, sent: 1, acknowledged: 0 });
    expect(theirs.refunds).toEqual({ required: 0, partial: 0, remainingKrw: "0" });
  });
});
