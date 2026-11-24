import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCancellationApi } from "../../src/db/pgCancellationApi";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
  for (let n = 1; n <= 45; n++) {
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
const key = () => `c-${++seq}`;
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
const num = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0].n as number;
const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();

type Scene = { orderId: string; lineId: string; reservationId?: string };
/** 확정 주문(품목 1개, 단가 15,000원). `paid`면 전액 결제 확인, `reserve`면 그만큼 재고 예약 */
async function scene(book: number, quantity: number, options: { paid?: boolean; reserve?: number; stock?: number } = {}): Promise<Scene> {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  let reservationId: string | undefined;
  if (options.reserve !== undefined) {
    await rows(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', $3, '초기 재고', 'seed', now())`, [T_A, BOOK(book), options.stock ?? options.reserve]);
    reservationId = (await createPgStockApi({ pool: db.pool() }).reserveStock(owner, { tenantId: T_A, orderId: order.id, orderLineId: lineId, quantity: options.reserve, reservedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() })).id;
  }
  if (options.paid) {
    const pay = createPgPaymentApi({ pool: db.pool() });
    const p = await pay.recordPayment(staff, { tenantId: T_A, orderId: order.id, method: "BANK_TRANSFER", amountKrw: String(quantity * 15000), externalReference: `C-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
    await pay.confirmPayment(staff, { tenantId: T_A, paymentId: p.id, evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
  }
  return { orderId: order.id, lineId, reservationId };
}
const deliver = (s: Scene, quantity: number, actor = staff) =>
  createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(actor, {
    tenantId: T_A,
    orderId: s.orderId,
    orderLineId: s.lineId,
    sources: [{ kind: "STOCK_RESERVATION", sourceId: s.reservationId!, quantity }],
    receivedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: key(),
  });
const requestCancel = (s: Scene, quantity: number, expectedVersion = 2, actor = staff) =>
  createPgFulfillmentApi({ pool: db.pool() }).requestOrderCancellation(actor, {
    tenantId: T_A,
    orderId: s.orderId,
    orderLineId: s.lineId,
    quantity,
    reason: "고객이 취소를 요청",
    expectedVersion,
    requestedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: key(),
  });
const decide = (api: ReturnType<typeof createPgCancellationApi>, requestId: string, decision: "APPROVED" | "REJECTED" | "WITHDRAWN", actor = owner) =>
  api.decideOrderCancellation(actor, { tenantId: T_A, requestId, decision, decidedAt: "2026-03-04T06:47:00.000Z", idempotencyKey: key() });
const apply = (api: ReturnType<typeof createPgCancellationApi>, requestId: string, actor = owner) =>
  api.applyOrderCancellation(actor, { tenantId: T_A, requestId, appliedAt: "2026-03-04T06:49:00.000Z", idempotencyKey: key() });
const orderRow = async (orderId: string) => (await rows("select status, version::int as version, total_krw::int as total, cancelled_at, closed_at from public.ordering_orders where id = $1", [orderId]))[0];
const lineQty = async (lineId: string) => num("select quantity::int as n from public.ordering_order_lines where id = $1", [lineId]);

describe("주문 취소 결정·적용 (Postgres 영속화)", () => {
  it("요청 → Owner 승인 → 적용이 주문 수량·합계·version을 줄이고 초과 확보된 예약을 해제하며 환급 필요 업무를 연다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const s = await scene(1, 3, { paid: true, reserve: 3 }); // 결제 45,000원, 예약 3권
    const request = await requestCancel(s, 1);

    expect((await decide(api, request.id, "APPROVED")).kind).toBe("APPROVED");
    const applied = await apply(api, request.id);

    expect(applied).toMatchObject({ kind: "APPLIED", decidedBy: OWNER_A });
    expect(await lineQty(s.lineId)).toBe(2);
    expect(await orderRow(s.orderId)).toMatchObject({ version: 3, total: 30000 });
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_releases where reservation_id = $1", [s.reservationId])).toBe(1); // 필요 2 < 확보 3
    const task = await rows("select required_krw::int as required, opened_by from public.ordering_refund_tasks where order_id = $1", [s.orderId]);
    expect(task).toEqual([{ required: 15000, opened_by: OWNER_A }]); // 확인 45,000 - 새 합계 30,000
  });

  it("승인·거절·적용은 Owner만, 철회는 Staff도 가능하고, 이미 결정된 요청의 재결정·미승인 요청의 적용은 거부된다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const s = await scene(2, 2, { reserve: 2 });
    const a = await requestCancel(s, 1);

    expect(await codeOf(() => decide(api, a.id, "APPROVED", staff))).toBe("FORBIDDEN");
    expect(await codeOf(() => apply(api, a.id))).toBe("BUSINESS_INVARIANT"); // 아직 승인 전
    expect(await codeOf(() => apply(api, a.id, staff))).toBe("FORBIDDEN");
    expect((await decide(api, a.id, "WITHDRAWN", staff)).kind).toBe("WITHDRAWN");
    expect(await codeOf(() => decide(api, a.id, "APPROVED"))).toBe("BUSINESS_INVARIANT"); // 이미 결정됨
    expect(await codeOf(() => decide(api, "0a000000-0000-4000-8000-00000000ffff", "APPROVED"))).toBe("NOT_FOUND");
    expect(await codeOf(() => decide(api, a.id, "APPROVED", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await lineQty(s.lineId)).toBe(2); // 아무것도 바뀌지 않았다
  });

  it("승인 뒤 주문 version이 바뀌었으면 적용하지 않고 STALE로 기록한다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const s = await scene(3, 3, { reserve: 3 });
    const first = await requestCancel(s, 1);
    const second = await requestCancel(s, 1);
    await decide(api, first.id, "APPROVED");
    await decide(api, second.id, "APPROVED");

    expect((await apply(api, first.id)).kind).toBe("APPLIED"); // version 2 -> 3
    const stale = await apply(api, second.id); // 기준 version 2는 낡았다
    expect(stale.kind).toBe("STALE");
    expect(await lineQty(s.lineId)).toBe(2);
  });

  it("이미 인도한 수량은 새 필요량에 반영되어 남은 예약만 해제하고, 전량 취소하면 주문이 CANCELLING이 되어 새 거래가 막힌다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const s = await scene(4, 3, { paid: true, reserve: 3 });
    await deliver(s, 1);
    const request = await requestCancel(s, 2);
    await decide(api, request.id, "APPROVED");
    await apply(api, request.id);

    expect(await lineQty(s.lineId)).toBe(1);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_releases where reservation_id = $1", [s.reservationId])).toBe(2); // 필요 1 - 인도 1 = 0, 남은 예약 2 전부 해제

    const full = await scene(5, 2, { reserve: 2 });
    const all = await requestCancel(full, 2);
    await decide(api, all.id, "APPROVED");
    await apply(api, all.id);
    expect((await orderRow(full.orderId)).cancelled_at).not.toBeNull();
    const pay = createPgPaymentApi({ pool: db.pool() });
    expect(await codeOf(() => pay.recordPayment(staff, { tenantId: T_A, orderId: full.orderId, method: "CARD", amountKrw: "1000", externalReference: `X-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT");
  });

  it("입고 배분으로 확보된 물량은 취소 적용 때 해제되지 않고 처분 대기로 옮겨진다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const receiving = createPgReceivingApi({ pool: db.pool() });
    const s = await scene(6, 2);
    const poId = (await rows(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T_A]))[0].id as string;
    const poLineId = (await rows(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, 2) returning id`, [T_A, poId, BOOK(6)]))[0].id as string;
    await rows(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, 2)`, [T_A, poLineId, s.orderId, s.lineId]);
    const receipt = await receiving.receiveGoods(staff, { tenantId: T_A, purchaseOrderId: poId, poLineId, normalQuantity: 2, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() });
    const allocation = await receiving.allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: s.orderId, orderLineId: s.lineId, quantity: 2, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });

    const request = await requestCancel(s, 2);
    await decide(api, request.id, "APPROVED");
    await apply(api, request.id);

    const cancelled = await rows("select quantity, book_key, cancelled_by from public.ordering_allocation_cancellations where allocation_id = $1", [allocation.id]);
    expect(cancelled).toEqual([{ quantity: 2, book_key: BOOK(6), cancelled_by: OWNER_A }]);
    expect(await num("select count(*)::int as n from public.ordering_allocation_releases where allocation_id = $1", [allocation.id])).toBe(0);
  });

  it("같은 멱등 키로 다시 적용해도 같은 결과이고(재시작 뒤에도) 주문은 한 번만 줄어든다", async () => {
    const s = await scene(7, 2, { reserve: 2 });
    const request = await requestCancel(s, 1);
    await decide(createPgCancellationApi({ pool: db.pool() }), request.id, "APPROVED");
    const body = { tenantId: T_A, requestId: request.id, appliedAt: "2026-03-04T06:49:00.000Z", idempotencyKey: key() };

    const first = await createPgCancellationApi({ pool: db.pool() }).applyOrderCancellation(owner, body);
    const retry = await createPgCancellationApi({ pool: db.pool() }).applyOrderCancellation(owner, body);

    expect(retry).toEqual(first);
    expect(await lineQty(s.lineId)).toBe(1);
    expect((await orderRow(s.orderId)).version).toBe(3);
  });
});

describe("취소 적용의 실제 동시성 (두 독립 세션)", () => {
  it("두 세션이 같은 승인된 요청을 동시에 적용하면 한 번만 적용된다", async () => {
    const s = await scene(8, 3, { reserve: 3 });
    const request = await requestCancel(s, 1);
    await decide(createPgCancellationApi({ pool: db.pool() }), request.id, "APPROVED");

    const results = await Promise.allSettled([
      apply(createPgCancellationApi({ pool: db.pool() }), request.id),
      apply(createPgCancellationApi({ pool: db.pool() }), request.id),
    ]);

    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await lineQty(s.lineId)).toBe(2);
    expect((await orderRow(s.orderId)).version).toBe(3);
    expect(await num("select count(*)::int as n from public.ordering_order_cancellation_decisions where request_id = $1 and kind = 'APPLIED'", [request.id])).toBe(1);
  });

  it("취소 적용과 잠기지 않은 수량의 인도가 동시에 들어와도 둘 다 성공하고 수량·예약 불변식이 지켜진다", async () => {
    const s = await scene(9, 3, { paid: true, reserve: 3 });
    const request = await requestCancel(s, 1); // 잠긴 1권
    await decide(createPgCancellationApi({ pool: db.pool() }), request.id, "APPROVED");

    const results = await Promise.allSettled([apply(createPgCancellationApi({ pool: db.pool() }), request.id), deliver(s, 2)]);

    expect(outcomes(results)).toEqual(["OK", "OK"]);
    const lineQuantity = await lineQty(s.lineId);
    const delivered = await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_fulfillments where order_line_id = $1", [s.lineId]);
    const released = await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_releases where reservation_id = $1", [s.reservationId]);
    const deliveredFromReservation = await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_deliveries where reservation_id = $1", [s.reservationId]);
    expect(lineQuantity).toBe(2);
    expect(delivered).toBe(2);
    expect(delivered).toBeLessThanOrEqual(lineQuantity);
    expect(released + deliveredFromReservation).toBeLessThanOrEqual(3); // 예약 3권을 넘겨 쓰지 않는다
  });

  it("직접 SQL로도 인도한 수량보다 적게 주문 수량을 줄일 수 없고 종결·취소된 주문에는 결제·예약·인도를 넣을 수 없다", async () => {
    const s = await scene(10, 2, { paid: true, reserve: 2 });
    await deliver(s, 2);
    const c = await db.connect();
    try {
      expect(await sqlState(() => c.query(`update public.ordering_order_lines set quantity = 1 where id = '${s.lineId}'`))).toBe("P0001"); // 인도 2권보다 적게
      const closed = await scene(11, 1, { paid: true });
      await c.query(`update public.ordering_orders set closed_at = now(), version = version + 1 where id = '${closed.orderId}'`);
      const payment = `insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ('${T_A}', '${closed.orderId}', 'CARD', 100, 'DIRECT-${key()}', now(), 'raw')`;
      expect(await sqlState(() => c.query(payment))).toBe("P0001");
      const reservation = `insert into public.ordering_stock_reservations (tenant_id, book_key, order_id, order_line_id, quantity, reserved_by, reserved_at) values ('${T_A}', '${BOOK(11)}', '${closed.orderId}', '${closed.lineId}', 1, 'raw', now())`;
      expect(await sqlState(() => c.query(reservation))).toBe("P0001");
    } finally {
      await c.end();
    }
  });
});

describe("주문 종결 요청·실행 (서버 전용 실행)", () => {
  const request = (api: ReturnType<typeof createPgCancellationApi>, orderId: string, expectedVersion: number, actor = staff) =>
    api.requestOrderClosure(actor, { tenantId: T_A, orderId, expectedVersion, requestedAt: "2026-03-04T06:58:00.000Z", idempotencyKey: key() });
  const execute = (api: ReturnType<typeof createPgCancellationApi>, closureRequestId: string, tenantId = T_A) =>
    api.executeOrderClosure({ tenantId, closureRequestId, executedAt: "2026-03-04T06:59:00.000Z", idempotencyKey: key() });

  it("결제·인도가 끝난 주문은 Staff의 요청 뒤 서버가 재계산해 종결하고, 종결된 주문에는 새 거래가 막힌다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const s = await scene(12, 2, { paid: true, reserve: 2 });
    await deliver(s, 2);
    const before = await orderRow(s.orderId);

    const req = await request(api, s.orderId, before.version);
    expect(req).toMatchObject({ orderId: s.orderId, requestedBy: STAFF_A });
    const closure = await execute(api, req.id);

    expect(closure).toMatchObject({ orderId: s.orderId, executedBy: "SYSTEM", orderVersionBefore: before.version, orderVersionAfter: before.version + 1 });
    expect((await orderRow(s.orderId)).closed_at).not.toBeNull();
    expect(await codeOf(() => deliver(s, 1))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => execute(api, req.id))).toBe("BUSINESS_INVARIANT"); // 이미 종결됨
  });

  it("미인도·잔액·미해소 처분 등 차단 사유가 있으면 BUSINESS_INVARIANT이고, 낡은 version·없는 요청은 거부되며 주문은 바뀌지 않는다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const undelivered = await scene(13, 2, { paid: true, reserve: 2 });
    const before = await orderRow(undelivered.orderId);
    const req = await request(api, undelivered.orderId, before.version);

    let thrown: unknown;
    try {
      await execute(api, req.id);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).detail).toContain("UNDELIVERED");
    expect(await orderRow(undelivered.orderId)).toEqual(before);

    await deliver(undelivered, 1);
    expect(await codeOf(() => execute(api, req.id))).toBe("BUSINESS_INVARIANT"); // 인도는 version을 올리지 않으므로 요청은 유효하지만 1권이 남았다
    await deliver(undelivered, 1);
    expect((await execute(api, req.id)).orderId).toBe(undelivered.orderId); // 서버는 실행하는 지금 다시 계산한다
    // 요청 뒤 주문 version이 바뀌었으면(취소 적용 등) VERSION_CONFLICT다
    const changed = await scene(41, 2, { reserve: 2 });
    const changedReq = await request(api, changed.orderId, 2);
    const cancel = await requestCancel(changed, 1);
    await decide(api, cancel.id, "APPROVED");
    await apply(api, cancel.id); // version 2 -> 3
    expect(await codeOf(() => execute(api, changedReq.id))).toBe("VERSION_CONFLICT");
  });

  it("종결 요청은 Staff·Owner가 할 수 있고 비멤버는 FORBIDDEN, 종결 실행은 없는 요청·타 서점에서 NOT_FOUND이다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const s = await scene(14, 1, { paid: true });
    expect(await codeOf(() => request(api, s.orderId, 2, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => request(api, s.orderId, 2, { userId: EX_STAFF_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => request(api, s.orderId, 9))).toBe("VERSION_CONFLICT");
    expect((await request(api, s.orderId, 2, owner)).requestedBy).toBe(OWNER_A);
    expect(await codeOf(() => execute(api, "0a000000-0000-4000-8000-00000000ffff"))).toBe("NOT_FOUND");
  });

  it("전량 취소되고 입고 배분의 처분이 끝나지 않은 주문은 DISPOSITION_OPEN으로 차단되고, 재고 편입이 기록되면 취소 종결된다", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const receiving = createPgReceivingApi({ pool: db.pool() });
    const s = await scene(15, 2);
    const poId = (await rows(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T_A]))[0].id as string;
    const poLineId = (await rows(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, 2) returning id`, [T_A, poId, BOOK(15)]))[0].id as string;
    await rows(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, 2)`, [T_A, poLineId, s.orderId, s.lineId]);
    const receipt = await receiving.receiveGoods(staff, { tenantId: T_A, purchaseOrderId: poId, poLineId, normalQuantity: 2, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() });
    const allocation = await receiving.allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: s.orderId, orderLineId: s.lineId, quantity: 2, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });
    const cancel = await requestCancel(s, 2);
    await decide(api, cancel.id, "APPROVED");
    await apply(api, cancel.id);

    const version = (await orderRow(s.orderId)).version;
    const req = await request(api, s.orderId, version);
    let blocked: unknown;
    try {
      await execute(api, req.id);
    } catch (error) {
      blocked = error;
    }
    expect((blocked as AppError).detail).toContain("DISPOSITION_OPEN");

    const cancellationId = (await rows("select id from public.ordering_allocation_cancellations where allocation_id = $1", [allocation.id]))[0].id as string;
    await rows(`insert into public.ordering_stock_intakes (tenant_id, cancellation_id, quantity, acted_by, acted_at) values ($1, $2, 2, 'seed', now())`, [T_A, cancellationId]);
    const closure = await execute(api, req.id);

    expect(closure).toMatchObject({ outcome: "CANCELLED", orderId: s.orderId });
  });

  it("종결 실행과 새 결제 입력이 동시에 들어와도 일관된 결과 하나만 나온다 (종결되거나, 결제가 먼저 들어가 종결이 차단되거나)", async () => {
    const api = createPgCancellationApi({ pool: db.pool() });
    const s = await scene(16, 1, { paid: true, reserve: 1 });
    await deliver(s, 1);
    const version = (await orderRow(s.orderId)).version;
    const req = await request(api, s.orderId, version);

    const results = await Promise.allSettled([
      execute(createPgCancellationApi({ pool: db.pool() }), req.id),
      createPgPaymentApi({ pool: db.pool() }).recordPayment(staff, { tenantId: T_A, orderId: s.orderId, method: "CARD", amountKrw: "500", externalReference: `RACE-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() }),
    ]);

    const closed = (await orderRow(s.orderId)).closed_at !== null;
    const payments = await num("select count(*)::int as n from public.ordering_payments where order_id = $1 and amount_krw = 500", [s.orderId]);
    const [closure, payment] = results;
    if (closed) {
      expect(closure!.status).toBe("fulfilled");
      expect(payment!.status).toBe("rejected"); // 종결 뒤에는 결제를 받지 않는다
      expect(payments).toBe(0);
    } else {
      expect(closure!.status).toBe("rejected"); // 미확인 결제가 먼저 들어가 종결이 차단됐다
      expect(payment!.status).toBe("fulfilled");
      expect(payments).toBe(1);
    }
  });
});
