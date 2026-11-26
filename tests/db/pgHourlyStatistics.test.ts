import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * DASH-007 기간별 통계(시간대별): 영업 시간 **오전 9시부터 저녁 10시까지 1시간 간격**(09:00~22:00, 13칸)의 서점 현지 시각(Asia/Seoul)별로
 * 주어진 기간(날짜 구간)의 업무량을 **기초 단위**(건수·수량(권)·금액(원, 정수 문자열))로 합산한다. 영업 시간 밖 업무는 따로 합산한다.
 */
const T = "aaaaaaaa-0000-4000-8000-0000000000b9";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000ba";
const OWNER = "11111111-0000-4000-8000-0000000000b9";
const STAFF = "11111111-0000-4000-8000-0000000000bb";
const EX_STAFF = "11111111-0000-4000-8000-0000000000bc";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000ba";
const STRANGER = "99999999-0000-4000-8000-0000000000b9";
/** 서점 현지 시각(KST, UTC+9) 2026-03-04 hh:mm → UTC ISO */
const kst = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+09:00`).toISOString();

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const reads = () => createPgReadApi({ pool: db.pool(), now: () => new Date("2026-03-10T00:00:00.000Z") });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
let seq = 0;

/** 초안으로 품목을 넣고(수량 배열) 필요하면 확정한다 */
async function order(tenant: string, createdAt: string, quantities: number[], confirm = false, discard = false) {
  const id = (await q(`insert into public.ordering_orders (tenant_id, status, created_at) values ($1, 'DRAFT', $2) returning id`, [tenant, createdAt]))[0].id as string;
  const lines: string[] = [];
  for (const [i, quantity] of quantities.entries()) {
    lines.push((await q(`insert into public.ordering_order_lines (tenant_id, order_id, position, book_key, quantity, unit_price_krw) values ($1, $2, $3, 'b', $4, 10000) returning id`, [tenant, id, i + 1, quantity]))[0].id as string);
  }
  if (confirm) await q(`update public.ordering_orders set status = 'CONFIRMED', version = 2, display_number = $2, total_krw = $3 where id = $1`, [id, ++seq, quantities.reduce((a, b) => a + b, 0) * 10000]);
  if (discard) await q(`update public.ordering_orders set discarded_at = now(), discard_reason = '철회', discarded_by = 'u', version = 2 where id = $1`, [id]);
  return { id, lines };
}
const payment = async (tenant: string, orderId: string, amount: number, paidAt: string, state: "confirmed" | "pending" | "voided") => {
  const id = (await q(`insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ($1, $2, 'BANK_TRANSFER', $3, $4, $5, 'u') returning id`, [tenant, orderId, amount, `EXT-${++seq}`, paidAt]))[0].id as string;
  if (state === "confirmed") await q(`insert into public.ordering_payment_confirmations (tenant_id, payment_id, evidence, confirmed_by, confirmed_at) values ($1, $2, '확인', 'u', now())`, [tenant, id]);
  if (state === "voided") await q(`insert into public.ordering_payment_voids (tenant_id, payment_id, reason, voided_by, voided_at) values ($1, $2, '중복', 'u', now())`, [tenant, id]);
};

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);

  // 주문(작성 시각, KST): 09:30(3권, 확정)·09:45(2권)·21:59(1권) / 영업 시간 밖: 08:59(4권)·22:00(5권) / 기간 밖: 03-05 10:00(7권) / 폐기: 10:00(9권)
  const o1 = await order(T, kst("2026-03-04", "09:30"), [2, 1], true);
  await order(T, kst("2026-03-04", "09:45"), [2]);
  await order(T, kst("2026-03-04", "21:59"), [1]);
  await order(T, kst("2026-03-04", "08:59"), [4]);
  await order(T, kst("2026-03-04", "22:00"), [5]);
  await order(T, kst("2026-03-05", "10:00"), [7]);
  await order(T, kst("2026-03-04", "10:00"), [9], false, true);
  await order(OTHER_T, kst("2026-03-04", "09:10"), [6]); // 다른 서점

  // 결제(결제 시각, KST): 10:15 확인 30000, 10:50 대기, 11:00 무효 → 확인된 것만 / 영업 시간 밖 22:30 확인 7000
  await payment(T, o1.id, 30000, kst("2026-03-04", "10:15"), "confirmed");
  await payment(T, o1.id, 5000, kst("2026-03-04", "10:50"), "pending");
  await payment(T, o1.id, 4000, kst("2026-03-04", "11:00"), "voided");
  await payment(T, o1.id, 7000, kst("2026-03-04", "22:30"), "confirmed");
  // 수령(수령 시각, KST): 14:10 2권, 14:40 정정 −1권(순 1권), 영업 시간 밖 06:00 1권
  const first = (await q(`insert into public.ordering_fulfillments (tenant_id, order_id, order_line_id, quantity, unit_price_krw, amount_krw, received_by, received_at) values ($1, $2, $3, 2, 10000, 20000, 'u', $4) returning id`, [T, o1.id, o1.lines[0], kst("2026-03-04", "14:10")]))[0].id as string;
  await q(`insert into public.ordering_fulfillments (tenant_id, order_id, order_line_id, quantity, unit_price_krw, amount_krw, received_by, received_at, corrects_fulfillment_id) values ($1, $2, $3, -1, 10000, -10000, 'u', $4, $5)`, [T, o1.id, o1.lines[0], kst("2026-03-04", "14:40"), first]);
  await q(`insert into public.ordering_fulfillments (tenant_id, order_id, order_line_id, quantity, unit_price_krw, amount_krw, received_by, received_at) values ($1, $2, $3, 1, 10000, 10000, 'u', $4)`, [T, o1.id, o1.lines[1], kst("2026-03-04", "06:00")]);
  // 입고(검수 시각, KST): 15:30 정상 4, 15:59 정상 3, 22:30 정상 2(영업 시간 밖)
  const poId = (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup', 'SENT', 3) returning id`, [T]))[0].id as string;
  const poLine = (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, 'b', 20) returning id`, [T, poId]))[0].id as string;
  for (const [hhmm, normal] of [["15:30", 4], ["15:59", 3], ["22:30", 2]] as const) {
    await q(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, inspected_by, received_at) values ($1, $2, $3, $4, 'u', $5)`, [T, poId, poLine, normal, kst("2026-03-04", hhmm)]);
  }
}, 240_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const stats = (userId: string, tenantId: string, extra: Record<string, unknown> = {}) => reads().getHourlyStatistics({ userId }, { tenantId, from: "2026-03-04", to: "2026-03-04", ...extra });

describe("시간대별 기간 통계 (DASH-007)", () => {
  it("영업 시간 09:00~22:00을 1시간 간격 13칸으로 서점 현지 시각(KST) 기준 건수·수량(권)·금액(원)으로 합산한다", async () => {
    const s = await stats(STAFF, T);
    expect(s).toMatchObject({ timezone: "Asia/Seoul", from: "2026-03-04", to: "2026-03-04" });
    expect(s.hours.map((h) => h.hour)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(s.hours.map((h) => h.label)).toEqual(["09:00-10:00", "10:00-11:00", "11:00-12:00", "12:00-13:00", "13:00-14:00", "14:00-15:00", "15:00-16:00", "16:00-17:00", "17:00-18:00", "18:00-19:00", "19:00-20:00", "20:00-21:00", "21:00-22:00"]);
    const at = (hour: number) => s.hours.find((h) => h.hour === hour)!;

    expect(at(9).orders).toEqual({ count: 2, quantity: 5 }); // 09:30(3권)·09:45(2권)
    expect(at(21).orders).toEqual({ count: 1, quantity: 1 }); // 21:59는 21시 칸(22:00은 밖)
    expect(at(10).orders).toEqual({ count: 0, quantity: 0 }); // 폐기된 초안은 세지 않는다
    expect(at(10).payments).toEqual({ count: 1, amountKrw: "30000" }); // 확인된 결제만(대기·무효 제외)
    expect(at(14).deliveries).toEqual({ quantity: 1 }); // 수령 2 − 정정 1
    expect(at(15).receipts).toEqual({ quantity: 7 }); // 15:30 정상 4 + 15:59 정상 3
    expect(at(12)).toEqual({ hour: 12, label: "12:00-13:00", orders: { count: 0, quantity: 0 }, payments: { count: 0, amountKrw: "0" }, receipts: { quantity: 0 }, deliveries: { quantity: 0 } });
  });

  it("영업 시간 밖(09:00 전·22:00 이후)의 업무는 outsideBusinessHours로 따로 합산하고, 기간(날짜)과 다른 서점은 제외한다", async () => {
    const s = await stats(OWNER, T);
    expect(s.outsideBusinessHours).toEqual({
      orders: { count: 2, quantity: 9 }, // 08:59(4권)·22:00(5권)
      payments: { count: 1, amountKrw: "7000" }, // 22:30
      receipts: { quantity: 2 }, // 22:30
      deliveries: { quantity: 1 }, // 06:00
    });
    // 03-05 10:00 주문(7권)은 03-04 하루 기간에 들지 않지만 03-04~03-05 기간에는 10시 칸에 든다
    const two = await stats(OWNER, T, { to: "2026-03-05" });
    expect(two.hours.find((h) => h.hour === 10)!.orders).toEqual({ count: 1, quantity: 7 });
    // 다른 서점의 09:10 주문(6권)은 섞이지 않는다
    expect((await stats(OTHER_OWNER, OTHER_T)).hours.find((h) => h.hour === 9)!.orders).toEqual({ count: 1, quantity: 6 });
  });

  it("from·to를 생략하면 서점 현지 오늘까지 최근 30일이고, 형식·순서·범위(최대 366일)가 틀리면 VALIDATION_ERROR이다", async () => {
    const d = await reads().getHourlyStatistics({ userId: OWNER }, { tenantId: T });
    expect(d).toMatchObject({ from: "2026-02-09", to: "2026-03-10" }); // 기준 시각 2026-03-10T00:00Z = KST 09:00 → 오늘 03-10, 30일 = 02-09~03-10
    for (const bad of [{ from: "2026-3-4" }, { from: "어제" }, { to: "2026-02-30" }, { from: "2026-03-05", to: "2026-03-04" }, { from: "2025-01-01", to: "2026-03-04" }, { from: 20260304 as never }]) {
      expect(await codeOf(() => stats(OWNER, T, bad)), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect(await codeOf(() => stats(OWNER, T, { from: "2025-03-04", to: "2026-03-04" }))).toBe("OK"); // 정확히 366일
  });

  it("비멤버·비활성·다른 서점 Owner는 FORBIDDEN(검증보다 먼저)이다", async () => {
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => stats(userId, T, { from: "어제" })), userId).toBe("FORBIDDEN");
  });
});
