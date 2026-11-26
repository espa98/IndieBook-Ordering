import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * O-09 수령·결제 현황: 확정 주문별 결제 요약(확인·미확인·잔액·환급 필요)과 수령 수량(주문·수령·남은 수량).
 * 결제 숫자는 주문별 `getOrderPayments`의 요약을 오라클로 대조하고, 수령 수량은 손계산과 대조한다.
 */
const T = "aaaaaaaa-0000-4000-8000-0000000000a7";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000a8";
const OWNER = "11111111-0000-4000-8000-0000000000a7";
const STAFF = "11111111-0000-4000-8000-0000000000a9";
const EX_STAFF = "11111111-0000-4000-8000-0000000000aa";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000a8";
const STRANGER = "99999999-0000-4000-8000-0000000000a7";

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

/** 초안으로 품목을 넣고 확정한다(품목은 초안에만 넣을 수 있다). 총액은 수량 × 10000 */
async function confirmedOrder(tenant: string, displayNumber: number, createdAt: string, quantities: number[], closed = false) {
  const id = (await q(`insert into public.ordering_orders (tenant_id, status, created_at) values ($1, 'DRAFT', $2) returning id`, [tenant, createdAt]))[0].id as string;
  const lines: string[] = [];
  for (const [i, quantity] of quantities.entries()) {
    lines.push((await q(`insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw) values ($1, $2, $3, 'b', $4, 10000) returning id`, [tenant, id, i + 1, quantity]))[0].id as string);
  }
  const total = quantities.reduce((a, b) => a + b, 0) * 10000;
  await q(`update public.ordering_orders set status = 'CONFIRMED', version = 2, display_number = $2, total_krw = $3 ${closed ? ", closed_at = now()" : ""} where id = $1`, [id, displayNumber, total]);
  return { id, lines };
}
const pay = async (tenant: string, orderId: string, amount: number, confirmed: boolean) => {
  const id = (await q(`insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ($1, $2, 'BANK_TRANSFER', $3, $4, now(), 'u') returning id`, [tenant, orderId, amount, `EXT-${++seq}`]))[0].id as string;
  if (confirmed) await q(`insert into public.ordering_payment_confirmations (tenant_id, payment_id, evidence, confirmed_by, confirmed_at) values ($1, $2, '입금 확인', 'u', now())`, [tenant, id]);
};
const fulfill = (tenant: string, orderId: string, lineId: string, quantity: number, correctsId: string | null = null) =>
  q(`insert into public.ordering_fulfillments (tenant_id, order_id, order_line_id, quantity, unit_price_krw, amount_krw, received_by, received_at, corrects_fulfillment_id) values ($1, $2, $3, $4, 10000, $5, 'u', now(), $6) returning id`, [tenant, orderId, lineId, quantity, quantity * 10000, correctsId]);

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);

  // O1: 3권 전량 결제·전량 수령
  const o1 = await confirmedOrder(T, 1, "2026-03-01T00:00:00Z", [3]);
  await pay(T, o1.id, 30000, true);
  await fulfill(T, o1.id, o1.lines[0]!, 3);
  // O2: 2권+1권, 10000 확인(수령한 1권만큼), 1권만 수령
  const o2 = await confirmedOrder(T, 2, "2026-03-02T00:00:00Z", [2, 1]);
  await pay(T, o2.id, 10000, true);
  await fulfill(T, o2.id, o2.lines[1]!, 1);
  // O3: 4권, 30000 확인 + 5000 미확인, 3권 수령 후 1권 정정(순 2권)
  const o3 = await confirmedOrder(T, 3, "2026-03-03T00:00:00Z", [4]);
  await pay(T, o3.id, 30000, true);
  await pay(T, o3.id, 5000, false);
  const first = (await fulfill(T, o3.id, o3.lines[0]!, 3))[0].id as string;
  await fulfill(T, o3.id, o3.lines[0]!, -1, first);
  // O4: 종결된 주문(기본 목록에서 제외)
  await confirmedOrder(T, 4, "2026-03-04T00:00:00Z", [1], true);
  // 초안은 대상이 아니다, 다른 서점 주문은 섞이지 않는다
  await q(`insert into public.ordering_orders (tenant_id, status, created_at) values ($1, 'DRAFT', '2026-03-05T00:00:00Z')`, [T]);
  await confirmedOrder(OTHER_T, 1, "2026-03-06T00:00:00Z", [1]);
  Object.assign(ids, { O1: o1.id, O2: o2.id, O3: o3.id });
}, 240_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("수령·결제 현황 (O-09)", () => {
  it("종결되지 않은 확정 주문을 최신순으로, 결제 요약과 수령 수량(주문·수령·남은)과 함께 보여 준다", async () => {
    const page = await reads().listOrderSettlements({ userId: STAFF }, { tenantId: T });
    expect(page.items.map((i) => i.orderId)).toEqual([ids.O3, ids.O2, ids.O1]);
    const by = Object.fromEntries(page.items.map((i) => [i.orderId, i]));
    expect(by[ids.O1!]).toEqual({
      orderId: ids.O1, displayNumber: 1, totalKrw: "30000", confirmedKrw: "30000", pendingKrw: "0", balanceKrw: "0", refundRequiredKrw: "0",
      orderedQuantity: 3, deliveredQuantity: 3, remainingQuantity: 0,
    });
    expect(by[ids.O2!]).toMatchObject({ totalKrw: "30000", confirmedKrw: "10000", balanceKrw: "20000", orderedQuantity: 3, deliveredQuantity: 1, remainingQuantity: 2 });
    expect(by[ids.O3!]).toMatchObject({ totalKrw: "40000", confirmedKrw: "30000", pendingKrw: "5000", balanceKrw: "10000", orderedQuantity: 4, deliveredQuantity: 2, remainingQuantity: 2 });
  });

  it("결제 숫자는 주문별 결제 요약(getOrderPayments)과 같다(오라클)", async () => {
    const page = await reads().listOrderSettlements(owner(), { tenantId: T });
    for (const item of page.items) {
      const { summary } = await reads().getOrderPayments(owner(), { tenantId: T, orderId: item.orderId });
      expect({ totalKrw: item.totalKrw, confirmedKrw: item.confirmedKrw, pendingKrw: item.pendingKrw, balanceKrw: item.balanceKrw, refundRequiredKrw: item.refundRequiredKrw }).toEqual(summary);
    }
  });

  it("unpaid=true는 잔액이 남은 주문만, undelivered=true는 남은 수량이 있는 주문만, includeClosed=true는 종결 주문도 보여 준다", async () => {
    const ids_ = async (query: object) => (await reads().listOrderSettlements(owner(), { tenantId: T, ...query })).items.map((i) => i.orderId);
    expect(await ids_({ unpaid: true })).toEqual([ids.O3, ids.O2]);
    expect(await ids_({ undelivered: true })).toEqual([ids.O3, ids.O2]);
    expect(await ids_({ unpaid: true, undelivered: true })).toEqual([ids.O3, ids.O2]);
    expect((await ids_({ includeClosed: true })).length).toBe(4);
  });

  it("커서로 끝까지 걸으면 전부 한 번씩 나오고(필터 뒤에도 이어진다), 잘못된 입력은 VALIDATION_ERROR, 비멤버·비활성은 FORBIDDEN이며 다른 서점 주문은 섞이지 않는다", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reads().listOrderSettlements(owner(), { tenantId: T, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.orderId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([ids.O3, ids.O2, ids.O1]);
    const first = await reads().listOrderSettlements(owner(), { tenantId: T, unpaid: true, limit: 1 });
    expect((await reads().listOrderSettlements(owner(), { tenantId: T, unpaid: true, limit: 1, cursor: first.nextCursor })).items.map((i) => i.orderId)).toEqual([ids.O2]);

    for (const bad of [{ limit: 0 }, { cursor: "%%%" }, { unpaid: "yes" as never }, { undelivered: "no" as never }, { includeClosed: 1 as never }]) {
      expect(await codeOf(() => reads().listOrderSettlements(owner(), { tenantId: T, ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().listOrderSettlements({ userId }, { tenantId: T, limit: 0 })), userId).toBe("FORBIDDEN");
    expect((await reads().listOrderSettlements({ userId: OTHER_OWNER }, { tenantId: OTHER_T })).items).toHaveLength(1);
  });
});

function owner() {
  return { userId: OWNER };
}
