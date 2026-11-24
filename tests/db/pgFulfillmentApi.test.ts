import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
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
  for (let n = 1; n <= 20; n++) {
    await c.query(
      `insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at)
       values ($1, $2, $3, 10000, 'MANUAL', '시험', 'seed', now())`,
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
const key = () => `f-${++seq}`;
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

const seedStock = (book: number, quantity: number) =>
  rows(
    `insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at)
     values ($1, $2, 'INITIAL', 'IN', $3, '초기 재고', 'seed', now())`,
    [T_A, BOOK(book), quantity],
  );

/**
 * 확정 주문(품목 1개, 단가 15,000원)을 만들고 재고를 시드·예약하고 결제를 확인한다.
 * `paidKrw`가 0이면 결제는 하지 않는다.
 */
async function deliverable(book: number, quantity: number, options: { paidKrw?: number; reserve?: number; stock?: number } = {}) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  await seedStock(book, options.stock ?? quantity);
  const lineId = order.lines[0]!.lineId;
  const reservation = await createPgStockApi({ pool: db.pool() }).reserveStock(owner, {
    tenantId: T_A,
    orderId: order.id,
    orderLineId: lineId,
    quantity: options.reserve ?? quantity,
    reservedAt: "2026-03-04T06:40:00.000Z",
    idempotencyKey: key(),
  });
  const paid = options.paidKrw ?? quantity * 15000;
  if (paid > 0) {
    const pay = createPgPaymentApi({ pool: db.pool() });
    const p = await pay.recordPayment(staff, { tenantId: T_A, orderId: order.id, method: "BANK_TRANSFER", amountKrw: String(paid), externalReference: `F-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
    await pay.confirmPayment(staff, { tenantId: T_A, paymentId: p.id, evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
  }
  return { orderId: order.id, lineId, reservationId: reservation.id };
};
const fulfillBody = (d: { orderId: string; lineId: string; reservationId: string }, quantity: number) => ({
  tenantId: T_A,
  orderId: d.orderId,
  orderLineId: d.lineId,
  sources: [{ kind: "STOCK_RESERVATION" as const, sourceId: d.reservationId, quantity }],
  receivedAt: "2026-03-04T06:50:00.000Z",
  idempotencyKey: key(),
});
const cancelBody = (d: { orderId: string; lineId: string }, quantity: number, expectedVersion = 2) => ({
  tenantId: T_A,
  orderId: d.orderId,
  orderLineId: d.lineId,
  quantity,
  reason: "고객이 취소를 요청",
  expectedVersion,
  requestedAt: "2026-03-04T06:45:00.000Z",
  idempotencyKey: key(),
});

describe("createPgFulfillmentApi.postFulfillment: 수령(인도)을 Postgres 영속화로 실행", () => {
  it("인도하면 수령 기록·예약 인도·재고 보유 감소가 한 트랜잭션으로 저장되고, 같은 멱등 키는 같은 결과를 돌려준다 (재시작 뒤에도)", async () => {
    const d = await deliverable(1, 2, { stock: 5 });
    const body = fulfillBody(d, 2);

    const fulfillment = await createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, body);
    const retry = await createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, body);

    expect(fulfillment).toMatchObject({ orderId: d.orderId, orderLineId: d.lineId, quantity: 2, amountKrw: "30000", receivedBy: STAFF_A });
    expect(retry).toEqual(fulfillment);
    expect(await num("select count(*)::int as n from public.ordering_fulfillments where order_id = $1", [d.orderId])).toBe(1);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_deliveries where reservation_id = $1", [d.reservationId])).toBe(2);
    // 보유 5 → 3, 예약 2 → 0 이라 가용은 그대로 3이다
    const onHand = await num("select coalesce(sum(case direction when 'IN' then quantity else -quantity end), 0)::int as n from public.ordering_stock_movements where book_key = $1", [BOOK(1)]);
    expect(onHand).toBe(3);
    expect((await rows("select kind, direction, reservation_id from public.ordering_stock_movements where kind = 'DELIVERY' and reservation_id = $1", [d.reservationId]))[0]).toMatchObject({ direction: "OUT" });
  });

  it("결제 확인액·품목 수량·예약 잔량을 넘는 인도와 다른 품목의 예약 출처는 거부되고 아무것도 저장되지 않는다", async () => {
    const api = createPgFulfillmentApi({ pool: db.pool() });
    const unpaid = await deliverable(2, 2, { paidKrw: 0 });
    const half = await deliverable(3, 2, { paidKrw: 15000 }); // 1권분만 확인
    const full = await deliverable(4, 2);
    const other = await deliverable(5, 2);
    const before = await num("select count(*)::int as n from public.ordering_fulfillments");

    expect(await codeOf(() => api.postFulfillment(staff, fulfillBody(unpaid, 1)))).toBe("BUSINESS_INVARIANT"); // 결제 없음
    expect(await codeOf(() => api.postFulfillment(staff, fulfillBody(half, 2)))).toBe("BUSINESS_INVARIANT"); // 확인액 15,000 < 30,000
    expect((await api.postFulfillment(staff, fulfillBody(half, 1))).amountKrw).toBe("15000");
    expect(await codeOf(() => api.postFulfillment(staff, fulfillBody(full, 3)))).toBe("BUSINESS_INVARIANT"); // 품목 2권 초과
    expect(await codeOf(() => api.postFulfillment(staff, { ...fulfillBody(full, 1), sources: [{ kind: "STOCK_RESERVATION", sourceId: other.reservationId, quantity: 1 }] }))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => api.postFulfillment(staff, { ...fulfillBody(full, 1), sources: [{ kind: "STOCK_RESERVATION", sourceId: "0a000000-0000-4000-8000-00000000ffff", quantity: 1 }] }))).toBe("NOT_FOUND");
    expect(await num("select count(*)::int as n from public.ordering_fulfillments")).toBe(before + 1);
  });

  it("입고 배분 출처는 아직 영속화하지 않아 VALIDATION_ERROR로 거부하고, 권한은 FORBIDDEN·UNAUTHENTICATED·타 서점 NOT_FOUND이다", async () => {
    const api = createPgFulfillmentApi({ pool: db.pool() });
    const d = await deliverable(6, 1);

    expect(
      await codeOf(() => api.postFulfillment(staff, { ...fulfillBody(d, 1), sources: [{ kind: "RECEIPT_ALLOCATION", sourceId: d.reservationId, quantity: 1 }] })),
    ).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api.postFulfillment({ userId: STRANGER }, fulfillBody(d, 1)))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.postFulfillment({ userId: EX_STAFF_A }, fulfillBody(d, 1)))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.postFulfillment({ userId: "" }, fulfillBody(d, 1)))).toBe("UNAUTHENTICATED");
    expect(await codeOf(() => api.postFulfillment({ userId: OWNER_B }, { ...fulfillBody(d, 1), tenantId: T_B }))).toBe("NOT_FOUND");
    expect(await num("select count(*)::int as n from public.ordering_fulfillments where order_id = $1", [d.orderId])).toBe(0);
  });
});

describe("createPgFulfillmentApi.requestOrderCancellation: 취소 요청 (D27 잠금)", () => {
  it("요청하면 저장되고 미인도·미잠금 수량을 넘는 요청과 낡은 version은 거부된다", async () => {
    const api = createPgFulfillmentApi({ pool: db.pool() });
    const d = await deliverable(7, 3);
    await api.postFulfillment(staff, fulfillBody(d, 1));

    const request = await api.requestOrderCancellation(staff, cancelBody(d, 2));
    expect(request).toMatchObject({ orderId: d.orderId, quantity: 2, requestedBy: STAFF_A, baseVersion: 2 });
    expect(await codeOf(() => api.requestOrderCancellation(staff, cancelBody(d, 1)))).toBe("BUSINESS_INVARIANT"); // 3 - 인도 1 - 잠금 2 = 0
    expect(await codeOf(() => api.requestOrderCancellation(staff, cancelBody(d, 1, 9)))).toBe("VERSION_CONFLICT");
    expect(await num("select count(*)::int as n from public.ordering_order_cancellation_requests where order_id = $1", [d.orderId])).toBe(1);
  });

  it("진행 중인 취소 요청이 있는 수량은 인도할 수 없다 (D27)", async () => {
    const api = createPgFulfillmentApi({ pool: db.pool() });
    const d = await deliverable(8, 2);
    await api.requestOrderCancellation(staff, cancelBody(d, 2));

    expect(await codeOf(() => api.postFulfillment(staff, fulfillBody(d, 1)))).toBe("BUSINESS_INVARIANT");
  });
});

describe("수령(인도)의 실제 동시성 (두 독립 세션)", () => {
  it("마지막 1권(예약 1권)을 두 세션이 동시에 인도하면 하나만 성공한다", async () => {
    const d = await deliverable(9, 1);
    const results = await Promise.allSettled([
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, fulfillBody(d, 1)),
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(owner, fulfillBody(d, 1)),
    ]);

    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_fulfillments where order_id = $1", [d.orderId])).toBe(1);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_deliveries where reservation_id = $1", [d.reservationId])).toBe(1);
  });

  it("예약 2권에 대해 세 세션이 동시에 1권씩 인도하면 정확히 2건만 성공하고 보유 재고가 음수가 되지 않는다", async () => {
    const d = await deliverable(10, 2, { stock: 2 });
    const results = await Promise.allSettled([1, 2, 3].map(() => createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, fulfillBody(d, 1))).map((p) => p));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_fulfillments where order_id = $1", [d.orderId])).toBe(2);
    expect(await num("select coalesce(sum(case direction when 'IN' then quantity else -quantity end), 0)::int as n from public.ordering_stock_movements where book_key = $1", [BOOK(10)])).toBe(0);
  });

  it("취소 요청과 인도가 같은 수량을 두고 동시에 들어오면 하나만 성공한다 (D27 잠금 경쟁)", async () => {
    const d = await deliverable(11, 2);
    const results = await Promise.allSettled([
      createPgFulfillmentApi({ pool: db.pool() }).requestOrderCancellation(staff, cancelBody(d, 2)),
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, fulfillBody(d, 2)),
    ]);

    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "OK"]);
    const fulfilled = await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_fulfillments where order_id = $1", [d.orderId]);
    const locked = await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_order_cancellation_requests where order_id = $1", [d.orderId]);
    expect(fulfilled + locked).toBe(2); // 같은 2권을 인도와 취소 요청이 동시에 차지하지 못한다
  });

  it("같은 멱등 키로 동시에 인도해도 수령 기록은 1건이고 두 호출이 같은 결과를 받는다", async () => {
    const d = await deliverable(12, 2);
    const body = fulfillBody(d, 1);

    const [x, y] = await Promise.all([
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, body),
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, body),
    ]);

    expect(x.id).toBe(y.id);
    expect(await num("select count(*)::int as n from public.ordering_fulfillments where order_id = $1", [d.orderId])).toBe(1);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_deliveries where reservation_id = $1", [d.reservationId])).toBe(1);
  });

  it("서로 다른 두 주문이 같은 책을 동시에 인도해도 교착 없이 모두 성공한다 (락 순서)", async () => {
    const [a, b] = [await deliverable(13, 1), await deliverable(13, 1)];
    const results = await Promise.allSettled([
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, fulfillBody(a, 1)),
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, fulfillBody(b, 1)),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});

describe("수령·재고 DB 불변식 (어댑터를 거치지 않는 쓰기도 지킨다)", () => {
  const insertFulfillment = (d: { orderId: string; lineId: string }, quantity: number, amount: number, extra = "") =>
    `insert into public.ordering_fulfillments (tenant_id, order_id, order_line_id, quantity, unit_price_krw, amount_krw, sources, received_by, received_at ${extra ? "," + extra.split("=")[0] : ""})
     values ('${T_A}', '${d.orderId}', '${d.lineId}', ${quantity}, 15000, ${amount}, '[]'::jsonb, 'raw', now() ${extra ? "," + extra.split("=")[1] : ""})`;

  it("직접 SQL로도 품목 수량·결제 확인액을 넘는 수령은 거부되고, 두 세션이 마지막 1권을 동시에 넣으면 하나만 들어간다", async () => {
    const d = await deliverable(14, 1);
    const a = await db.connect();
    const b = await db.connect();
    try {
      expect(await sqlState(() => a.query(insertFulfillment(d, 2, 30000)))).toBe("P0001"); // 품목 1권 초과
      const unpaid = await deliverable(15, 1, { paidKrw: 0 });
      expect(await sqlState(() => a.query(insertFulfillment(unpaid, 1, 15000)))).toBe("P0001"); // 확인된 결제 없음
      await a.query("begin");
      await b.query("begin");
      await a.query(insertFulfillment(d, 1, 15000));
      const second = sqlState(() => b.query(insertFulfillment(d, 1, 15000))); // a가 커밋할 때까지 주문 락에서 대기
      await a.query("commit");
      expect(await second).toBe("P0001");
      await b.query("rollback");
      expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_fulfillments where order_id = $1", [d.orderId])).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("직접 SQL의 취소 요청도 인도한 수량·진행 중 요청과 합쳐 품목 수량을 넘을 수 없고, 열린 요청이 있으면 그 수량의 인도가 거부된다", async () => {
    const d = await deliverable(16, 2);
    const c = await db.connect();
    try {
      const request = (qty: number) =>
        `insert into public.ordering_order_cancellation_requests (tenant_id, order_id, order_line_id, quantity, reason, base_version, requested_by, requested_at)
         values ('${T_A}', '${d.orderId}', '${d.lineId}', ${qty}, '사유', 2, 'raw', now())`;
      expect(await sqlState(() => c.query(request(3)))).toBe("P0001");
      expect(await sqlState(() => c.query(request(2)))).toBeUndefined();
      expect(await sqlState(() => c.query(insertFulfillment(d, 1, 15000)))).toBe("P0001"); // 잠긴 2권
      expect(await sqlState(() => c.query(request(1)))).toBe("P0001");
      // 요청이 거절되면 잠금이 풀린다
      const id = (await c.query(`select id from public.ordering_order_cancellation_requests where order_id = '${d.orderId}'`)).rows[0].id;
      await c.query(`insert into public.ordering_order_cancellation_decisions (tenant_id, request_id, kind, decided_by, decided_at) values ('${T_A}', '${id}', 'REJECTED', 'raw', now())`);
      expect(await sqlState(() => c.query(insertFulfillment(d, 1, 15000)))).toBeUndefined();
    } finally {
      await c.end();
    }
  });

  it("예약 인도는 예약 잔량을 넘을 수 없고 보유 재고를 넘는 출고도 거부되며, 수령·인도·취소 기록은 추가 전용이다", async () => {
    const d = await deliverable(17, 2, { stock: 2 });
    const c = await db.connect();
    try {
      const delivery = (qty: number) =>
        `insert into public.ordering_stock_reservation_deliveries (tenant_id, reservation_id, quantity, delivered_by, delivered_at) values ('${T_A}', '${d.reservationId}', ${qty}, 'raw', now())`;
      expect(await sqlState(() => c.query(delivery(3)))).toBe("P0001"); // 예약 2권 초과
      expect(await sqlState(() => c.query(delivery(-1)))).toBe("P0001"); // 인도하지 않은 것을 되돌릴 수 없다
      expect(await sqlState(() => c.query(delivery(2)))).toBeUndefined();
      expect(
        await sqlState(() =>
          c.query(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ('${T_A}', '${BOOK(17)}', 'ADJUST', 'OUT', 3, '사유', 'raw', now())`),
        ),
      ).toBe("P0001"); // 보유 2권 미만으로 내려간다
      for (const sql of [
        "update public.ordering_fulfillments set quantity = 9",
        "delete from public.ordering_fulfillments",
        "update public.ordering_order_cancellation_requests set quantity = 9",
        "delete from public.ordering_order_cancellation_decisions",
      ]) {
        expect(await sqlState(() => c.query(sql)), sql).toBe("P0001");
      }
    } finally {
      await c.end();
    }
  });
});
