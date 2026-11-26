import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * O-01-01 예외 업무 큐: 아직 해결되지 않은 예외를 한 목록으로. 유형 — 초과 입고(결정 안 된 수량), 미확인 결제, 환급 필요, 안내 실패(재안내 필요),
 * 공급처 취소 요청 미응답. 읽기 전용이며 종결·삭제 경로는 없다(DEC-16: 예외 임의 종결 금지). 장기 미수령은 `GET /long-unreceived-warnings`가 따로 다룬다.
 */
const T = "aaaaaaaa-0000-4000-8000-0000000000f7";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000f8";
const OWNER = "11111111-0000-4000-8000-0000000000f7";
const STAFF = "11111111-0000-4000-8000-0000000000f9";
const EX_STAFF = "11111111-0000-4000-8000-0000000000fa";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000f8";
const STRANGER = "99999999-0000-4000-8000-0000000000f7";
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

const confirmedOrder = async (tenant: string, n: number) => (await q(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ($1, 'CONFIRMED', $2, 100000) returning id`, [tenant, n]))[0].id as string;
const payment = async (tenant: string, orderId: string, state: "confirmed" | "pending" | "voided", paidAt: string, amount = 5000) => {
  const id = (await q(`insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ($1, $2, 'BANK_TRANSFER', $3, $4, $5, 'u') returning id`, [tenant, orderId, amount, `EXT-${++seq}`, paidAt]))[0].id as string;
  if (state === "confirmed") await q(`insert into public.ordering_payment_confirmations (tenant_id, payment_id, evidence, confirmed_by, confirmed_at) values ($1, $2, '확인', 'u', now())`, [tenant, id]);
  if (state === "voided") await q(`insert into public.ordering_payment_voids (tenant_id, payment_id, reason, voided_by, voided_at) values ($1, $2, '중복', 'u', now())`, [tenant, id]);
  return id;
};

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);

  const order1 = await confirmedOrder(T, 1);
  const order2 = await confirmedOrder(T, 2);
  const order3 = await confirmedOrder(T, 3);

  // 1) 초과 입고: 초과 2권 중 1권만 결정 → 남은 1권(day1), 전부 결정한 입고는 제외
  const poId = (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup', 'SENT', 3) returning id`, [T]))[0].id as string;
  const poLine = (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, 'b', 10) returning id`, [T, poId]))[0].id as string;
  const excess = async (excessQty: number, decided: number, at: string) => {
    const id = (await q(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, excess_quantity, inspected_by, received_at) values ($1, $2, $3, 0, $4, 'u', $5) returning id`, [T, poId, poLine, excessQty, at]))[0].id as string;
    if (decided > 0) await q(`insert into public.ordering_excess_decisions (tenant_id, receipt_id, decision, quantity, reason, decided_by, decided_at) values ($1, $2, 'APPROVED', $3, '승인', 'u', now())`, [T, id, decided]);
    return id;
  };
  ids.EXCESS = await excess(2, 1, day(1));
  await excess(1, 1, day(1)); // 모두 결정됨
  // 2) 미확인 결제: 대기 1(day2), 확인·무효는 제외
  ids.PAY = await payment(T, order1, "pending", day(2), 7000);
  await payment(T, order1, "confirmed", day(2));
  await payment(T, order1, "voided", day(2));
  // 3) 환급 필요: 미환급(day3)·일부 환급(day4), 완료는 제외
  const paid2 = await payment(T, order2, "confirmed", day(3), 50000);
  const paid3 = await payment(T, order3, "confirmed", day(3), 50000);
  const task = async (orderId: string, required: number, at: string) => (await q(`insert into public.ordering_refund_tasks (tenant_id, order_id, required_krw, opened_by, opened_at) values ($1, $2, $3, 'u', $4) returning id`, [T, orderId, required, at]))[0].id as string;
  ids.REFUND1 = await task(order2, 10000, day(3));
  ids.REFUND2 = await task(order3, 20000, day(4));
  await q(`insert into public.ordering_refund_confirmations (tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, confirmed_by, confirmed_at) values ($1, $2, $3, $4, 5000, '증빙', 'u', now())`, [T, ids.REFUND2, order3, paid3]);
  void paid2;
  const order4 = await confirmedOrder(T, 4);
  const paid4 = await payment(T, order4, "confirmed", day(3), 50000);
  const doneTask = await task(order4, 3000, day(4));
  await q(`insert into public.ordering_refund_confirmations (tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, confirmed_by, confirmed_at) values ($1, $2, $3, $4, 3000, '증빙', 'u', now())`, [T, doneTask, order4, paid4]);
  // 4) 안내 실패: 재안내가 없는 실패 대상(day5). 재안내된 원 대상·완료 대상은 제외
  const target = async (orderId: string, createdAt: string, renoticeOf: string | null = null) =>
    (await q(`insert into public.ordering_notification_targets (tenant_id, order_id, mode, renotice_of_target_id, lines, secured_total, created_by, created_at) values ($1, $2, 'FULL', $3, '[]'::jsonb, 1, 'u', $4) returning id`, [T, orderId, renoticeOf, createdAt]))[0].id as string;
  const outcome = async (targetId: string, result: string, at: string) => {
    const attempt = (await q(`insert into public.ordering_notification_attempts (tenant_id, target_id, channel, message_snapshot, attempted_by, attempted_at) values ($1, $2, 'SMS', '비밀 문구', 'u', $3) returning id`, [T, targetId, at]))[0].id as string;
    await q(`insert into public.ordering_notification_results (tenant_id, target_id, attempt_id, outcome, note, recorded_by, result_at) values ($1, $2, $3, $4, '비밀 메모', 'u', $5)`, [T, targetId, attempt, result, at]);
  };
  ids.NOTICE = await target(order1, day(5));
  await outcome(ids.NOTICE, "FAILED", day(5));
  const replaced = await target(order2, day(5));
  await outcome(replaced, "FAILED", day(5));
  await target(order2, day(5), replaced); // 재안내(대기): 실패 예외가 아니다
  const done = await target(order3, day(5));
  await outcome(done, "MANUAL_RECORDED", day(5));
  // 5) 공급처 취소 요청 미응답: 3권 요청에 1권만 응답 → 미응답 2권(day6), 모두 응답한 요청은 제외
  const request = async (qty: number, answered: number, at: string) => {
    const id = (await q(`insert into public.ordering_po_cancellation_requests (tenant_id, purchase_order_id, po_line_id, quantity, reason, requested_at) values ($1, $2, $3, $4, '취소', $5) returning id`, [T, poId, poLine, qty, at]))[0].id as string;
    if (answered > 0) await q(`insert into public.ordering_po_cancellation_responses (tenant_id, purchase_order_id, po_line_id, request_id, accepted_quantity, rejected_quantity, evidence, replied_at) values ($1, $2, $3, $4, $5, 0, '응답', now())`, [T, poId, poLine, id, answered]);
    return id;
  };
  ids.CANCEL = await request(3, 1, day(6));
  await request(2, 2, day(6));
  // 다른 서점
  const other = await confirmedOrder(OTHER_T, 1);
  await payment(OTHER_T, other, "pending", day(7));
}, 300_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("예외 업무 큐 (O-01-01)", () => {
  it("해결되지 않은 예외를 최신 발생 순으로 유형·대상·수량·금액과 함께 보여 준다(해결된 것은 빠진다)", async () => {
    const page = await reads().listExceptions({ userId: STAFF }, { tenantId: T });
    expect(page.items.map((i) => [i.type, i.refId])).toEqual([
      ["PO_CANCELLATION_UNANSWERED", ids.CANCEL], ["FAILED_NOTIFICATION", ids.NOTICE], ["REFUND_REQUIRED", ids.REFUND2], ["REFUND_REQUIRED", ids.REFUND1],
      ["UNCONFIRMED_PAYMENT", ids.PAY], ["EXCESS_RECEIPT", ids.EXCESS],
    ]);
    const by = Object.fromEntries(page.items.map((i) => [i.refId, i]));
    expect(by[ids.CANCEL!]).toMatchObject({ occurredAt: day(6), quantity: 2 });
    expect(by[ids.NOTICE!]).toMatchObject({ occurredAt: day(5), orderDisplayNumber: 1 });
    expect(by[ids.REFUND2!]).toMatchObject({ occurredAt: day(4), orderDisplayNumber: 3, amountKrw: "15000" }); // 20000 중 5000 환급
    expect(by[ids.REFUND1!]).toMatchObject({ amountKrw: "10000" });
    expect(by[ids.PAY!]).toMatchObject({ occurredAt: day(2), orderDisplayNumber: 1, amountKrw: "7000" });
    expect(by[ids.EXCESS!]).toMatchObject({ occurredAt: day(1), quantity: 1 }); // 초과 2 − 결정 1
    expect(by[ids.EXCESS!]).not.toHaveProperty("orderId");
    expect(JSON.stringify(page)).not.toMatch(/비밀/);
    expect(page.items.some((i) => i.refId === undefined)).toBe(false);
  });

  it("type 필터와 커서 페이지네이션이 동작한다(필터 뒤에도 커서가 이어진다)", async () => {
    expect((await reads().listExceptions(owner(), { tenantId: T, type: "REFUND_REQUIRED" })).items.map((i) => i.refId)).toEqual([ids.REFUND2, ids.REFUND1]);
    expect((await reads().listExceptions(owner(), { tenantId: T, type: "UNCONFIRMED_PAYMENT" })).items.map((i) => i.refId)).toEqual([ids.PAY]);
    expect((await reads().listExceptions(owner(), { tenantId: T, type: "EXCESS_RECEIPT" })).items.map((i) => i.refId)).toEqual([ids.EXCESS]);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reads().listExceptions(owner(), { tenantId: T, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.refId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([ids.CANCEL, ids.NOTICE, ids.REFUND2, ids.REFUND1, ids.PAY, ids.EXCESS]);
    const refunds = await reads().listExceptions(owner(), { tenantId: T, type: "REFUND_REQUIRED", limit: 1 });
    expect((await reads().listExceptions(owner(), { tenantId: T, type: "REFUND_REQUIRED", limit: 1, cursor: refunds.nextCursor })).items.map((i) => i.refId)).toEqual([ids.REFUND1]);
  });

  it("건수는 대시보드의 예외 건수와 같고, 잘못된 입력은 VALIDATION_ERROR, 비멤버·비활성은 FORBIDDEN(검증보다 먼저), 다른 서점 예외는 섞이지 않는다", async () => {
    for (const bad of [{ limit: 0 }, { cursor: "%%%" }, { type: "ALL" as never }]) expect(await codeOf(() => reads().listExceptions(owner(), { tenantId: T, ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().listExceptions({ userId }, { tenantId: T, limit: 0 })), userId).toBe("FORBIDDEN");
    expect((await reads().listExceptions({ userId: OTHER_OWNER }, { tenantId: OTHER_T })).items.map((i) => i.type)).toEqual(["UNCONFIRMED_PAYMENT"]);

    const dashboard = await reads().getDashboard(owner(), { tenantId: T });
    const all = (await reads().listExceptions(owner(), { tenantId: T })).items;
    expect(all.filter((i) => i.type === "REFUND_REQUIRED").length).toBe(dashboard.refunds.required + dashboard.refunds.partial);
    expect(all.filter((i) => i.type === "UNCONFIRMED_PAYMENT").length).toBe(dashboard.payments.unconfirmedPayments);
    expect(all.filter((i) => i.type === "FAILED_NOTIFICATION").length).toBe(dashboard.notifications.failed);
  });
});
