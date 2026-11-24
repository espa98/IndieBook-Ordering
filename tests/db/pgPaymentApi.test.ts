import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres, withJwt } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = "b0000000-0000-4000-8000-000000000001";

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
  await c.query(
    `insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at)
     values ($1, $2, '결제 시험 도서', 15000, 'MANUAL', '시험', 'seed', now())`,
    [BOOK, T_A],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const staff = { userId: STAFF_A };
let seq = 0;
const key = () => `p-${++seq}`;
const ref = () => `REF-${++seq}`;
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
const count = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0].n as number;

/** 합계 30,000원의 확정 주문 */
async function confirmedOrder(confirm = true) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK, quantity: 2, unitPriceKrw: "15000" }] });
  if (!confirm) return draft;
  return orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
}
const pay = (api: ReturnType<typeof createPgPaymentApi>, orderId: string, amountKrw: string, reference = ref()) =>
  api.recordPayment(staff, { tenantId: T_A, orderId, method: "BANK_TRANSFER", amountKrw, externalReference: reference, paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() });
const confirmPay = (api: ReturnType<typeof createPgPaymentApi>, paymentId: string) =>
  api.confirmPayment(staff, { tenantId: T_A, paymentId, evidence: "입금 내역 확인", confirmedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() });
const openTask = (api: ReturnType<typeof createPgPaymentApi>, orderId: string) =>
  api.openRefundTask(owner, { tenantId: T_A, orderId, openedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });
const requestRefund = (api: ReturnType<typeof createPgPaymentApi>, refundTaskId: string, paymentId: string, amountKrw: string, actor = staff) =>
  api.requestRefund(actor, { tenantId: T_A, refundTaskId, paymentId, amountKrw, evidence: "카드사 부분 취소 승인 내역", requestedAt: "2026-03-04T06:48:00.000Z", idempotencyKey: key() });
const decide = (api: ReturnType<typeof createPgPaymentApi>, requestId: string, decision: "APPROVED" | "REJECTED" | "WITHDRAWN", actor = owner) =>
  api.decideRefundRequest(actor, { tenantId: T_A, requestId, decision, decidedAt: "2026-03-04T06:52:00.000Z", idempotencyKey: key() });

/** 30,000원 주문에 35,000원이 확인되어 환급 5,000원 업무가 열린 세계 */
async function overpaidScene() {
  const api = createPgPaymentApi({ pool: db.pool() });
  const order = await confirmedOrder();
  const payment = await pay(api, order.id, "35000");
  await confirmPay(api, payment.id);
  const task = await openTask(api, order.id);
  return { api, order, payment, task };
}

describe("createPgPaymentApi: 결제·환급을 Postgres 영속화로 실행", () => {
  it("결제 입력 → 확인 → 환급 업무 → 환급 요청 → Owner 승인까지 이어지고, 행위자는 인증된 사용자로 기록되며 재시작 뒤에도 같은 결과다", async () => {
    const { api, order, payment, task } = await overpaidScene();

    expect(payment).toMatchObject({ orderId: order.id, amountKrw: "35000", recordedBy: STAFF_A });
    expect(task).toMatchObject({ orderId: order.id, requiredKrw: "5000", openedBy: OWNER_A });

    const request = await requestRefund(api, task.id, payment.id, "3000");
    expect(request).toMatchObject({ amountKrw: "3000", requestedBy: STAFF_A });
    expect(await codeOf(() => decide(api, request.id, "APPROVED", staff))).toBe("FORBIDDEN"); // 승인은 Owner만
    expect(await count("select count(*)::int as n from public.ordering_refund_confirmations")).toBe(0);

    const approved = await decide(createPgPaymentApi({ pool: db.pool() }), request.id, "APPROVED");
    expect(approved.decision).toMatchObject({ kind: "APPROVED", decidedBy: OWNER_A });
    expect(approved.refund).toMatchObject({ amountKrw: "3000", confirmedBy: OWNER_A, refundRequestId: request.id, verificationSource: "STAFF_MANUAL_EVIDENCE" });
    expect(await count("select count(*)::int as n from public.ordering_refund_confirmations where refund_request_id = $1", [request.id])).toBe(1);
    // 같은 결정을 다시 하면 거부된다
    expect(await codeOf(() => decide(api, request.id, "REJECTED"))).toBe("BUSINESS_INVARIANT");
  });

  it("같은 멱등 키는 같은 결과를 돌려주고 다른 본문은 IDEMPOTENCY_CONFLICT이며, 요청이 주장한 행위자 이름은 무시된다", async () => {
    const api = createPgPaymentApi({ pool: db.pool() });
    const order = await confirmedOrder();
    const body = { tenantId: T_A, orderId: order.id, method: "CARD" as const, amountKrw: "10000", externalReference: ref(), paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() };

    const first = await api.recordPayment(staff, { ...body, recordedBy: "점주" } as never);
    const retry = await createPgPaymentApi({ pool: db.pool() }).recordPayment(staff, body);

    expect(first.recordedBy).toBe(STAFF_A);
    expect(retry).toEqual(first);
    expect(await count("select count(*)::int as n from public.ordering_payments where order_id = $1", [order.id])).toBe(1);
    expect(await codeOf(() => api.recordPayment(staff, { ...body, amountKrw: "11000" }))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("같은 외부 거래는 서점 안에서 한 번만 기록되고, 초안 주문은 거부하며, 비멤버·비활성은 FORBIDDEN, 타 서점 주문은 NOT_FOUND이다", async () => {
    const api = createPgPaymentApi({ pool: db.pool() });
    const order = await confirmedOrder();
    const other = await confirmedOrder();
    const reference = ref();

    await pay(api, order.id, "1000", reference);
    expect(await codeOf(() => pay(api, other.id, "1000", reference))).toBe("BUSINESS_INVARIANT"); // 다른 주문에도 못 붙인다
    const draft = await confirmedOrder(false);
    expect(await codeOf(() => pay(api, draft.id, "1000"))).toBe("BUSINESS_INVARIANT");
    const base = { tenantId: T_A, orderId: order.id, method: "CARD" as const, amountKrw: "1000", paidAt: "2026-03-04T06:00:00.000Z" };
    expect(await codeOf(() => api.recordPayment({ userId: STRANGER }, { ...base, externalReference: ref(), idempotencyKey: key() }))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.recordPayment({ userId: EX_STAFF_A }, { ...base, externalReference: ref(), idempotencyKey: key() }))).toBe("FORBIDDEN");
    expect(await codeOf(() => api.recordPayment({ userId: "" }, { ...base, externalReference: ref(), idempotencyKey: key() }))).toBe("UNAUTHENTICATED");
    expect(await codeOf(() => api.recordPayment({ userId: OWNER_B }, { ...base, tenantId: T_B, externalReference: ref(), idempotencyKey: key() }))).toBe("NOT_FOUND");
  });

  it("미확인 결제는 환급 업무를 열 수 없고(과수납 없음), 환급 한도(업무 남은 필요액·원 결제 가용액)를 넘는 요청은 거부되며 아무것도 저장되지 않는다", async () => {
    const { api, order, payment, task } = await overpaidScene();
    const before = await count("select count(*)::int as n from public.ordering_refund_requests");

    expect(await codeOf(() => requestRefund(api, task.id, payment.id, "5001"))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => openTask(api, order.id))).toBe("BUSINESS_INVARIANT"); // 활성 환급 업무가 이미 있다
    const pending = await confirmedOrder();
    await pay(api, pending.id, "40000"); // 확인 전
    expect(await codeOf(() => openTask(api, pending.id))).toBe("BUSINESS_INVARIANT");
    expect(await count("select count(*)::int as n from public.ordering_refund_requests")).toBe(before);
  });

  it("해소되지 않은 UNKNOWN 환급 시도는 한도에서 예약되어 재요청이 막힌다 (TC-90)", async () => {
    const { api, order, payment, task } = await overpaidScene();
    await rows(
      `insert into public.ordering_refund_attempts (tenant_id, refund_task_id, order_id, payment_id, amount_krw, result, reason, reported_by, reported_at)
       values ($1, $2, $3, $4, 3000, 'UNKNOWN', '카드사 응답 시간 초과', 'seed', now())`,
      [T_A, task.id, order.id, payment.id],
    );

    expect(await codeOf(() => requestRefund(api, task.id, payment.id, "3000"))).toBe("BUSINESS_INVARIANT"); // 5,000 - 예약 3,000 = 2,000
    expect((await requestRefund(api, task.id, payment.id, "2000")).amountKrw).toBe("2000");
  });
});

describe("환급의 실제 동시성 (두 독립 세션)", () => {
  it("같은 업무에 두 세션이 동시에 3,000원씩 환급을 요청하면 하나만 접수되어 요청 합계가 필요액(5,000원)을 넘지 않는다", async () => {
    const { api, payment, task } = await overpaidScene();
    const apiB = createPgPaymentApi({ pool: db.pool() });

    const results = await Promise.allSettled([requestRefund(api, task.id, payment.id, "3000"), requestRefund(apiB, task.id, payment.id, "3000", owner)]);

    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await count("select coalesce(sum(amount_krw), 0)::int as n from public.ordering_refund_requests where refund_task_id = $1", [task.id])).toBe(3000);
  });

  it("두 세션이 같은 환급 요청을 동시에 승인해도 환급 원장은 한 번만 기록된다", async () => {
    const { api, payment, task } = await overpaidScene();
    const request = await requestRefund(api, task.id, payment.id, "4000");

    const results = await Promise.allSettled([
      decide(createPgPaymentApi({ pool: db.pool() }), request.id, "APPROVED"),
      decide(createPgPaymentApi({ pool: db.pool() }), request.id, "APPROVED"),
    ]);

    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await count("select count(*)::int as n from public.ordering_refund_confirmations where refund_request_id = $1", [request.id])).toBe(1);
    expect(await count("select coalesce(sum(amount_krw), 0)::int as n from public.ordering_refund_confirmations where refund_task_id = $1", [task.id])).toBe(4000);
  });

  it("승인과 거절이 동시에 들어와도 결정은 한 번만 기록되고, 승인이 이긴 경우에만 원장이 생긴다", async () => {
    const { api, payment, task } = await overpaidScene();
    const request = await requestRefund(api, task.id, payment.id, "2000");

    const results = await Promise.allSettled([
      decide(createPgPaymentApi({ pool: db.pool() }), request.id, "APPROVED"),
      decide(createPgPaymentApi({ pool: db.pool() }), request.id, "REJECTED"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const decisions = await rows("select kind from public.ordering_refund_request_decisions where request_id = $1", [request.id]);
    expect(decisions).toHaveLength(1);
    const ledger = await count("select count(*)::int as n from public.ordering_refund_confirmations where refund_request_id = $1", [request.id]);
    expect(ledger).toBe(decisions[0].kind === "APPROVED" ? 1 : 0);
  });

  it("같은 외부 거래를 서로 다른 주문에 동시에 기록하면 하나만 저장된다 (유일 제약, DEC-14)", async () => {
    const [a, b] = [await confirmedOrder(), await confirmedOrder()];
    const reference = ref();

    const results = await Promise.allSettled([
      pay(createPgPaymentApi({ pool: db.pool() }), a.id, "1000", reference),
      pay(createPgPaymentApi({ pool: db.pool() }), b.id, "1000", reference),
    ]);

    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect(await count("select count(*)::int as n from public.ordering_payments where external_reference = $1", [reference])).toBe(1);
  });

  it("같은 멱등 키로 동시에 결제를 입력하면 결제는 1건만 생기고 두 호출이 같은 결과를 받는다", async () => {
    const order = await confirmedOrder();
    const body = { tenantId: T_A, orderId: order.id, method: "EASY_PAY" as const, amountKrw: "2000", externalReference: ref(), paidAt: "2026-03-04T06:00:00.000Z", idempotencyKey: key() };

    const [x, y] = await Promise.all([createPgPaymentApi({ pool: db.pool() }).recordPayment(staff, body), createPgPaymentApi({ pool: db.pool() }).recordPayment(staff, body)]);

    expect(x.id).toBe(y.id);
    expect(await count("select count(*)::int as n from public.ordering_payments where order_id = $1", [order.id])).toBe(1);
  });
});

describe("결제·환급 원장 DB 불변식 (어댑터를 거치지 않는 쓰기도 지킨다)", () => {
  it("환급 원장은 요청 하나당 한 번, 업무 필요액과 원 결제 가용액 이내여야 하고, 두 세션이 남은 금액을 동시에 직접 넣어도 하나만 들어간다", async () => {
    const { api, order, payment, task } = await overpaidScene();
    const [r1, r2] = [await requestRefund(api, task.id, payment.id, "2500"), await requestRefund(api, task.id, payment.id, "2500")];
    const insert = (amount: number, requestId: string | null) =>
      `insert into public.ordering_refund_confirmations (tenant_id, refund_task_id, order_id, payment_id, amount_krw, evidence, confirmed_by, confirmed_at, refund_request_id)
       values ('${T_A}', '${task.id}', '${order.id}', '${payment.id}', ${amount}, '증빙', 'raw', now(), ${requestId === null ? "null" : `'${requestId}'`})`;
    const a = await db.connect();
    const b = await db.connect();
    try {
      expect(await sqlState(() => a.query(insert(5001, null)))).toBe("P0001"); // 필요액 초과
      await a.query("begin");
      await b.query("begin");
      await a.query(insert(3000, null));
      const second = sqlState(() => b.query(insert(3000, null))); // a가 커밋할 때까지 주문 락에서 대기
      await a.query("commit");
      expect(await second).toBe("P0001"); // 합계 6,000 > 5,000
      await b.query("rollback");
      expect(await sqlState(() => a.query(insert(1000, r1.id)))).toBeUndefined();
      expect(await sqlState(() => a.query(insert(1000, r1.id)))).toBe("23505"); // 같은 요청의 원장은 한 번
      expect(await sqlState(() => a.query(insert(1001, r2.id)))).toBe("P0001"); // 3,000 + 1,000 이후 남은 1,000원을 1원 넘는다
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("결제·환급 원장은 추가 전용이고 요청마다 결정은 한 번뿐이며 결제 금액·방법 제약을 지킨다", async () => {
    const { api, order, payment, task } = await overpaidScene();
    const request = await requestRefund(api, task.id, payment.id, "1000");
    await decide(api, request.id, "APPROVED");
    const c = await db.connect();
    try {
      for (const sql of [
        "update public.ordering_payments set amount_krw = 1",
        "delete from public.ordering_payments",
        "update public.ordering_refund_confirmations set amount_krw = 1",
        "delete from public.ordering_refund_confirmations",
        "update public.ordering_refund_requests set amount_krw = 1",
        "delete from public.ordering_refund_request_decisions",
        "update public.ordering_payment_confirmations set evidence = 'x'",
      ]) {
        expect(await sqlState(() => c.query(sql)), sql).toBe("P0001");
      }
      expect(
        await sqlState(() =>
          c.query(`insert into public.ordering_refund_request_decisions (tenant_id, request_id, kind, decided_by, decided_at) values ('${T_A}', '${request.id}', 'REJECTED', 'raw', now())`),
        ),
      ).toBe("23505");
      const base = (amount: string, method: string) =>
        `insert into public.ordering_payments (tenant_id, order_id, method, amount_krw, external_reference, paid_at, recorded_by) values ('${T_A}', '${order.id}', '${method}', ${amount}, '${ref()}', now(), 'raw')`;
      expect(await sqlState(() => c.query(base("0", "CARD")))).toBe("23514");
      expect(await sqlState(() => c.query(base("100", "CASH")))).toBe("23514");
    } finally {
      await c.end();
    }
  });

  it("결제·환급 테이블은 클라이언트(authenticated·anon)가 직접 읽지도 쓰지도 못한다 (RLS-03, 서버 경로만)", async () => {
    await overpaidScene();
    const c = await db.connect();
    try {
      for (const table of ["ordering_payments", "ordering_payment_confirmations", "ordering_refund_tasks", "ordering_refund_requests", "ordering_refund_confirmations"]) {
        expect(await withJwt(c, { role: "authenticated", claims: { sub: OWNER_A } }, () => sqlState(() => c.query(`select * from public.${table}`))), table).toBe("42501");
        expect(await withJwt(c, { role: "anon", claims: null }, () => sqlState(() => c.query(`select * from public.${table}`))), table).toBe("42501");
      }
    } finally {
      await c.end();
    }
  });
});
