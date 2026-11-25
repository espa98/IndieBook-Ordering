import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002"; // 재고 조정 위임 없음
const DELEGATE_A = "11111111-0000-4000-8000-000000000004"; // 재고 조정을 위임받은 직원
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER_A]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', true)`, [T_A, OWNER_A, STAFF_A, DELEGATE_A]);
  await c.query(`insert into public.ordering_stock_delegations (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, now())`, [T_A, DELEGATE_A, OWNER_A]);
  for (let n = 1; n <= 20; n++) {
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
const delegate = { userId: DELEGATE_A };
let seq = 0;
const key = () => `sa-${++seq}`;
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

const stock = () => createPgStockApi({ pool: db.pool() });
const initial = (book: number, quantity: number, actor = owner) => stock().registerInitialStock(actor, { tenantId: T_A, bookId: BOOK(book), quantity, actedAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
const adjust = (book: number, direction: "IN" | "OUT", quantity: number, actor = owner) =>
  stock().adjustStock(actor, { tenantId: T_A, bookId: BOOK(book), direction, quantity, reason: "실사 정정", actedAt: "2026-03-04T06:10:00.000Z", idempotencyKey: key() });
const onHand = (book: number) => num("select coalesce(sum(case direction when 'IN' then quantity else -quantity end), 0)::int as n from public.ordering_stock_movements where book_key = $1", [BOOK(book)]);

async function confirmedLine(book: number, quantity: number) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  return { orderId: order.id, lineId: order.lines[0]!.lineId };
}
const reserve = (line: { orderId: string; lineId: string }, quantity: number) =>
  stock().reserveStock(owner, { tenantId: T_A, orderId: line.orderId, orderLineId: line.lineId, quantity, reservedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });

const MISSING_BOOK = "b0000000-0000-4000-8000-0000000000ff";
const initialFor = (bookId: string, actor = owner, quantity = 5) =>
  stock().registerInitialStock(actor, { tenantId: T_A, bookId, quantity, actedAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
const ledgerRows = (bookId: string) => num("select count(*)::int as n from public.ordering_stock_movements where book_key = $1", [bookId]);

describe("재고는 이 서점에 등록된 도서에만 기록된다", () => {
  it("존재하지 않는 도서의 초기 재고 등록은 NOT_FOUND이고 재고 기록도 멱등 기록도 남기지 않는다", async () => {
    const commandsBefore = await num("select count(*)::int as n from public.ordering_commands");

    expect(await codeOf(() => initialFor(MISSING_BOOK))).toBe("NOT_FOUND");

    expect(await ledgerRows(MISSING_BOOK)).toBe(0);
    expect(await num("select count(*)::int as n from public.ordering_commands")).toBe(commandsBefore);
  });

  it("존재하지 않는 도서의 재고 조정은 초기 재고가 없다는 업무 규칙(422)보다 먼저 NOT_FOUND이고 아무것도 기록하지 않는다", async () => {
    const adjustFor = (bookId: string) =>
      stock().adjustStock(owner, { tenantId: T_A, bookId, direction: "IN", quantity: 1, reason: "실사 정정", actedAt: "2026-03-04T06:10:00.000Z", idempotencyKey: key() });

    expect(await codeOf(() => adjustFor(MISSING_BOOK))).toBe("NOT_FOUND");
    expect(await codeOf(() => adjust(2, "IN", 1))).toBe("BUSINESS_INVARIANT"); // 실제 도서이지만 초기 재고가 없으면 여전히 업무 규칙 위반이다

    expect(await ledgerRows(MISSING_BOOK)).toBe(0);
  });

  it("권한(403)과 입력 검증(400)이 도서 존재(404)보다 먼저이고, 다른 서점의 도서는 없는 도서와 같이 NOT_FOUND이다", async () => {
    // 도서의 존재 여부가 권한 없는 사용자에게 드러나지 않는다
    expect(await codeOf(() => initialFor(MISSING_BOOK, staff))).toBe("FORBIDDEN");
    expect(await codeOf(() => initialFor(MISSING_BOOK, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => initialFor(MISSING_BOOK, owner, 0))).toBe("VALIDATION_ERROR");

    const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
    const OTHER_BOOK = "b0000000-0000-4000-8000-0000000000aa";
    await rows(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 B', $2)`, [T_B, "22222222-0000-4000-8000-000000000001"]);
    await rows(`insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '타 서점 책', 10000, 'MANUAL', '시험', 'seed', now())`, [OTHER_BOOK, T_B]);

    expect(await codeOf(() => initialFor(OTHER_BOOK))).toBe("NOT_FOUND");
    expect(await ledgerRows(OTHER_BOOK)).toBe(0);
  });
});

describe("초기 재고 등록·재고 조정 (Postgres 영속화)", () => {
  it("Owner만 도서별로 한 번 초기 재고를 등록하고, 조정은 Owner 또는 위임된 직원만 하며 초기 재고 없음·예약 아래로의 감소·잘못된 입력은 거부된다", async () => {
    expect(await codeOf(() => initial(1, 5, staff))).toBe("FORBIDDEN"); // 초기 재고는 점주만 (DEC-19)
    expect(await codeOf(() => initial(1, 5, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => initial(1, 0))).toBe("VALIDATION_ERROR");
    const first = await initial(1, 5);
    expect(first).toMatchObject({ kind: "INITIAL", direction: "IN", quantity: 5, actedBy: OWNER_A });
    expect(await onHand(1)).toBe(5);
    expect(await codeOf(() => initial(1, 3))).toBe("BUSINESS_INVARIANT"); // 도서별 한 번만 (BR-Q22)

    expect(await codeOf(() => adjust(2, "IN", 1))).toBe("BUSINESS_INVARIANT"); // 초기 재고 등록 전에는 조정할 수 없다
    expect(await codeOf(() => adjust(1, "IN", 2, staff))).toBe("FORBIDDEN"); // 위임되지 않은 직원
    expect((await adjust(1, "IN", 2, delegate)).kind).toBe("ADJUST"); // 위임된 직원
    expect(await onHand(1)).toBe(7);
    expect((await adjust(1, "OUT", 3)).direction).toBe("OUT");
    expect(await onHand(1)).toBe(4);

    const line = await confirmedLine(1, 3);
    await reserve(line, 3); // 보유 4, 예약 3
    expect(await codeOf(() => adjust(1, "OUT", 2))).toBe("BUSINESS_INVARIANT"); // 보유가 예약(3) 아래로 내려간다
    expect((await adjust(1, "OUT", 1)).quantity).toBe(1); // 보유 3 = 예약 3은 허용
    expect(await codeOf(() => adjust(1, "OUT", 1))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => adjust(1, "IN", 0))).toBe("VALIDATION_ERROR");
  });

  it("같은 도서의 초기 재고를 동시에 등록하면 하나만 성공하고, 직접 SQL로도 예약 아래로의 조정 감소·초기 재고 없는 도서의 조정을 넣을 수 없다", async () => {
    const results = await Promise.allSettled([initial(3, 5), initial(3, 5)]);
    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await num("select count(*)::int as n from public.ordering_stock_movements where book_key = $1 and kind = 'INITIAL'", [BOOK(3)])).toBe(1);

    await initial(4, 4);
    const line = await confirmedLine(4, 3);
    await reserve(line, 3);
    const c = await db.connect();
    try {
      const ins = (kind: string, direction: string, qty: number) => `insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ('${T_A}', '${BOOK(4)}', '${kind}', '${direction}', ${qty}, '사유', 'raw', now())`;
      expect(await sqlState(() => c.query(ins("ADJUST", "OUT", 2)))).toBe("P0001"); // 보유 4 - 2 < 예약 3
      await c.query(ins("ADJUST", "OUT", 1)); // 보유 3 = 예약 3은 가능
      expect(await sqlState(() => c.query(ins("ADJUST", "IN", 1).replace(`'${BOOK(4)}'`, `'${BOOK(5)}'`)))).toBe("P0001"); // 초기 재고 없는 도서의 조정
    } finally {
      await c.end();
    }
  });
});

describe("재고 예약 해제 (Postgres 영속화)", () => {
  it("미인도 예약을 해제하면 가용 재고가 돌아오고, 인도한 수량·초과·없는 예약은 거부되며, 예약 해제와 인도가 마지막 1권을 두고 동시에 들어오면 하나만 성공한다", async () => {
    await initial(6, 3);
    const line = await confirmedLine(6, 3);
    const reservation = await reserve(line, 3);
    const release = (quantity: number, reservationId = reservation.id, actor = staff) =>
      stock().releaseStockReservation(actor, { tenantId: T_A, reservationId, quantity, reason: "고객 요청", releasedAt: "2026-03-04T06:50:00.000Z", idempotencyKey: key() });

    expect(await codeOf(() => release(1, reservation.id, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => release(1, "0a000000-0000-4000-8000-00000000ffff"))).toBe("NOT_FOUND");
    expect(await codeOf(() => release(4))).toBe("BUSINESS_INVARIANT"); // 예약 3권 초과
    const released = await release(2);
    expect(released).toMatchObject({ reservationId: reservation.id, quantity: 2, releasedBy: STAFF_A, bookId: BOOK(6) });
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_reservation_releases where reservation_id = $1", [reservation.id])).toBe(2);
    expect(await onHand(6)).toBe(3); // 보유 재고 원장은 바뀌지 않는다 (ST-I04)
    expect((await reserve(await confirmedLine(6, 2), 2)).quantity).toBe(2); // 풀린 2권은 다시 예약할 수 있다

    // 마지막 1권: 인도와 해제가 동시에 들어오면 하나만 성공한다
    await createPgPaymentApi({ pool: db.pool() }); // 결제 어댑터 로드 확인용(인도에 결제 확인이 필요하다)
    const o = await confirmedLine(6, 1);
    await initial(7, 1);
    const last = await (async () => {
      const line = await confirmedLine(7, 1);
      const r = await reserve(line, 1);
      const pay = createPgPaymentApi({ pool: db.pool() });
      const p = await pay.recordPayment(staff, { tenantId: T_A, orderId: line.orderId, method: "CARD", amountKrw: "15000", externalReference: `SA-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
      await pay.confirmPayment(staff, { tenantId: T_A, paymentId: p.id, evidence: "카드 승인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
      return { line, reservation: r };
    })();
    void o;
    const results = await Promise.allSettled([
      createPgFulfillmentApi({ pool: db.pool() }).postFulfillment(staff, { tenantId: T_A, orderId: last.line.orderId, orderLineId: last.line.lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: last.reservation.id, quantity: 1 }], receivedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() }),
      release(1, last.reservation.id),
    ]);
    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
  });
});

describe("결제 무효 (Postgres 영속화)", () => {
  it("확인 전 결제만 무효로 만들 수 있고(Staff·Owner), 확인된 결제·이미 무효된 결제는 거부되며, 무효된 결제는 확인할 수 없다", async () => {
    const line = await confirmedLine(8, 1);
    const pay = createPgPaymentApi({ pool: db.pool() });
    const record = () => pay.recordPayment(staff, { tenantId: T_A, orderId: line.orderId, method: "BANK_TRANSFER", amountKrw: "15000", externalReference: `VD-${key()}`, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
    const voidIt = (paymentId: string, actor = staff) => pay.voidPayment(actor, { tenantId: T_A, paymentId, reason: "오입력", voidedAt: "2026-03-04T06:20:00.000Z", idempotencyKey: key() });

    const wrong = await record();
    expect(await codeOf(() => voidIt(wrong.id, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => voidIt("0a000000-0000-4000-8000-00000000ffff"))).toBe("NOT_FOUND");
    expect(await voidIt(wrong.id)).toMatchObject({ paymentId: wrong.id, reason: "오입력", voidedBy: STAFF_A });
    expect((await rows("select reason, voided_by from public.ordering_payment_voids where payment_id = $1", [wrong.id]))[0]).toEqual({ reason: "오입력", voided_by: STAFF_A });
    expect(await codeOf(() => voidIt(wrong.id))).toBe("BUSINESS_INVARIANT"); // 이미 무효
    expect(await codeOf(() => pay.confirmPayment(staff, { tenantId: T_A, paymentId: wrong.id, evidence: "근거", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT"); // 무효된 결제는 확인할 수 없다

    const confirmed = await record();
    await pay.confirmPayment(staff, { tenantId: T_A, paymentId: confirmed.id, evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
    expect(await codeOf(() => voidIt(confirmed.id))).toBe("BUSINESS_INVARIANT"); // 확인된 결제는 정정으로 다룬다

    // 같은 결제를 동시에 무효·확인하면 하나만 성공한다
    const racing = await record();
    const results = await Promise.allSettled([
      voidIt(racing.id),
      createPgPaymentApi({ pool: db.pool() }).confirmPayment(staff, { tenantId: T_A, paymentId: racing.id, evidence: "입금 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() }),
    ]);
    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
  });
});
