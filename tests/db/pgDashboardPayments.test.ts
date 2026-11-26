import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 대시보드의 미결제 집계(DASH-005)는 주문별 결제 요약(`paymentSummary`)과 같은 규칙이어야 한다.
 * 확정 주문마다 읽기 API의 요약을 오라클로 삼아 합계를 대조한다(확인 거래 − 환급 − 보정, 무효 제외).
 */
const T = "aaaaaaaa-0000-4000-8000-0000000000a5";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000a6";
const OWNER = "11111111-0000-4000-8000-0000000000a5";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000a6";

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
let seq = 0;
const confirmedOrder = async (tenant: string, total: number) =>
  (await q(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ($1, 'CONFIRMED', $2, $3) returning id`, [tenant, ++seq, total]))[0].id as string;
const payment = async (tenant: string, orderId: string, amount: number, state: "confirmed" | "pending" | "voided") => {
  const id = (await q(`insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ($1, $2, 'BANK_TRANSFER', $3, $4, now(), 'u') returning id`, [tenant, orderId, amount, `EXT-${++seq}`]))[0].id as string;
  if (state === "confirmed") await q(`insert into public.ordering_payment_confirmations (tenant_id, payment_id, evidence, confirmed_by, confirmed_at) values ($1, $2, '입금 확인', 'u', now())`, [tenant, id]);
  if (state === "voided") await q(`insert into public.ordering_payment_voids (tenant_id, payment_id, reason, voided_by, voided_at) values ($1, $2, '중복', 'u', now())`, [tenant, id]);
  return id;
};

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER]);

  const o1 = await confirmedOrder(T, 10000); // 전액 결제
  await payment(T, o1, 10000, "confirmed");
  const o2 = await confirmedOrder(T, 20000); // 일부 결제 + 미확인 거래
  await payment(T, o2, 5000, "confirmed");
  await payment(T, o2, 3000, "pending");
  await confirmedOrder(T, 30000); // 결제 없음
  const o4 = await confirmedOrder(T, 8000); // 확인 10000에서 4000 보정
  const p4 = await payment(T, o4, 10000, "confirmed");
  await q(`insert into public.ordering_payment_corrections (tenant_id, order_id, payment_id, reduced_krw, reason, evidence, corrected_by, corrected_at) values ($1, $2, $3, 4000, '오기록', '재확인', 'u', now())`, [T, o4, p4]);
  const o5 = await confirmedOrder(T, 5000); // 무효 거래는 제외
  await payment(T, o5, 2000, "voided");
  const o6 = await confirmedOrder(T, 7000); // 과수납
  await payment(T, o6, 9000, "confirmed");
  await q(`insert into public.ordering_orders (tenant_id, status) values ($1, 'DRAFT')`, [T]); // 초안은 대상이 아니다
  const theirs = await confirmedOrder(OTHER_T, 99999); // 다른 서점
  await payment(OTHER_T, theirs, 1, "pending");
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const reads = () => createPgReadApi({ pool: db.pool() });

describe("대시보드 미결제 집계 (DASH-005)", () => {
  it("미결제 주문 수·미결제 잔액 합계·미확인 거래 수가 확정 주문별 결제 요약의 합과 같다(오라클)", async () => {
    const dashboard = await reads().getDashboard({ userId: OWNER }, { tenantId: T });
    expect(dashboard.payments).toEqual({ unpaidOrders: 4, balanceKrw: "52000", unconfirmedPayments: 1 });

    // 오라클: 주문별 읽기 API의 요약을 합산
    const ids = (await q(`select id from public.ordering_orders where tenant_id = $1 and status = 'CONFIRMED'`, [T])).map((r) => r.id as string);
    let unpaid = 0;
    let balance = 0n;
    let pending = 0;
    for (const orderId of ids) {
      const view = await reads().getOrderPayments({ userId: OWNER }, { tenantId: T, orderId });
      if (BigInt(view.summary.balanceKrw) > 0n) {
        unpaid++;
        balance += BigInt(view.summary.balanceKrw);
      }
      pending += view.payments.filter((p) => p.status === "PENDING").length;
    }
    expect({ unpaidOrders: unpaid, balanceKrw: balance.toString(), unconfirmedPayments: pending }).toEqual(dashboard.payments);
  });

  it("다른 서점의 결제는 섞이지 않는다", async () => {
    expect((await reads().getDashboard({ userId: OTHER_OWNER }, { tenantId: OTHER_T })).payments).toEqual({ unpaidOrders: 1, balanceKrw: "99999", unconfirmedPayments: 1 });
  });
});
