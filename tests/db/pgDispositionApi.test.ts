import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCancellationApi } from "../../src/db/pgCancellationApi";
import { createPgDispositionApi } from "../../src/db/pgDispositionApi";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER_A]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T_A, OWNER_A, STAFF_A]);
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
let seq = 0;
const key = () => `d-${++seq}`;
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

/** 입고 배분된 물량을 주문 전량 취소로 풀어 처분 대기(취소 물량) 하나를 만든다. 재고 원장이 필요하면 `initialStock`으로 시드한다 */
async function cancelledAllocation(book: number, quantity: number, options: { initialStock?: boolean } = {}) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  if (options.initialStock) {
    await rows(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', 1, '초기 재고', 'seed', now())`, [T_A, BOOK(book)]);
  }
  const poId = (await rows(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T_A]))[0].id as string;
  const poLineId = (await rows(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, $4) returning id`, [T_A, poId, BOOK(book), quantity]))[0].id as string;
  await rows(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, $5)`, [T_A, poLineId, order.id, lineId, quantity]);
  const receiving = createPgReceivingApi({ pool: db.pool() });
  const receipt = await receiving.receiveGoods(staff, { tenantId: T_A, purchaseOrderId: poId, poLineId, normalQuantity: quantity, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:35:00.000Z", idempotencyKey: key() });
  const allocation = await receiving.allocateReceipt(staff, { tenantId: T_A, receiptId: receipt.id, orderId: order.id, orderLineId: lineId, quantity, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() });
  const cancel = await createPgFulfillmentApi({ pool: db.pool() }).requestOrderCancellation(staff, {
    tenantId: T_A, orderId: order.id, orderLineId: lineId, quantity, reason: "고객이 취소를 요청", expectedVersion: 2, requestedAt: "2026-03-04T06:45:00.000Z", idempotencyKey: key(),
  });
  const cancellations = createPgCancellationApi({ pool: db.pool() });
  await cancellations.decideOrderCancellation(owner, { tenantId: T_A, requestId: cancel.id, decision: "APPROVED", decidedAt: "2026-03-04T06:47:00.000Z", idempotencyKey: key() });
  await cancellations.applyOrderCancellation(owner, { tenantId: T_A, requestId: cancel.id, appliedAt: "2026-03-04T06:49:00.000Z", idempotencyKey: key() });
  const cancellationId = (await rows("select id from public.ordering_allocation_cancellations where allocation_id = $1", [allocation.id]))[0].id as string;
  return { orderId: order.id, bookKey: BOOK(book), cancellationId, receiptId: receipt.id };
}
const intake = (api: ReturnType<typeof createPgDispositionApi>, cancellationId: string, quantity: number, actor = owner) =>
  api.transferCancelledToStock(actor, { tenantId: T_A, cancellationId, quantity, actedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() });

describe("취소 물량의 재고 편입 (Postgres 영속화)", () => {
  it("Owner가 취소 물량을 재고로 편입하면 편입 기록과 재고 입고 원장이 함께 남고, Staff·비멤버·초과·초기 재고 없음·없는 취소 물량은 거부된다", async () => {
    const api = createPgDispositionApi({ pool: db.pool() });
    const c = await cancelledAllocation(1, 3, { initialStock: true });

    const result = await intake(api, c.cancellationId, 2);

    expect(result.intake).toMatchObject({ cancellationId: c.cancellationId, quantity: 2, actedBy: OWNER_A, orderId: c.orderId, receiptId: c.receiptId });
    expect(result.movement).toMatchObject({ kind: "CANCEL_TO_STOCK", direction: "IN", quantity: 2, cancellationId: c.cancellationId });
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_intakes where cancellation_id = $1", [c.cancellationId])).toBe(2);
    expect(await num("select count(*)::int as n from public.ordering_stock_movements where cancellation_id = $1 and kind = 'CANCEL_TO_STOCK'", [c.cancellationId])).toBe(1);

    expect(await codeOf(() => intake(api, c.cancellationId, 1, staff))).toBe("FORBIDDEN");
    expect(await codeOf(() => intake(api, c.cancellationId, 1, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => intake(api, c.cancellationId, 2))).toBe("BUSINESS_INVARIANT"); // 처분 대기 1권뿐
    expect(await codeOf(() => intake(api, "0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    const noStock = await cancelledAllocation(2, 1); // 초기 재고 미등록
    expect(await codeOf(() => intake(api, noStock.cancellationId, 1))).toBe("BUSINESS_INVARIANT");
  });
});

const requestReturn = (api: ReturnType<typeof createPgDispositionApi>, cancellationId: string, quantity: number, actor = owner) =>
  api.requestReturn(actor, { tenantId: T_A, cancellationId, quantity, requestedAt: "2026-03-04T06:56:00.000Z", idempotencyKey: key() });

describe("취소 물량의 공급처 반품 요청 (Postgres 영속화)", () => {
  it("Owner의 반품 요청이 원 입고·공급처를 참조해 저장되고, 편입과 같은 물량에 배타적이며 Staff·초과는 거부된다", async () => {
    const api = createPgDispositionApi({ pool: db.pool() });
    const c = await cancelledAllocation(3, 3, { initialStock: true });

    const request = await requestReturn(api, c.cancellationId, 2);

    expect(request).toMatchObject({ cancellationId: c.cancellationId, receiptId: c.receiptId, supplierCode: "sup-a", quantity: 2, requestedBy: OWNER_A });
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_return_requests where cancellation_id = $1", [c.cancellationId])).toBe(2);
    expect(await codeOf(() => requestReturn(api, c.cancellationId, 1, staff))).toBe("FORBIDDEN");
    expect(await codeOf(() => requestReturn(api, c.cancellationId, 2))).toBe("BUSINESS_INVARIANT"); // 처분 대기 1권뿐
    expect(await codeOf(() => intake(api, c.cancellationId, 2))).toBe("BUSINESS_INVARIANT"); // 반품 요청 중인 수량은 편입할 수 없다
    expect((await intake(api, c.cancellationId, 1)).intake.quantity).toBe(1);
    expect(await codeOf(() => requestReturn(api, "0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
  });
});

type Api = ReturnType<typeof createPgDispositionApi>;
const reply = (api: Api, returnRequestId: string, acceptedQuantity: number, rejectedQuantity: number, actor = staff) =>
  api.recordReturnReply(actor, { tenantId: T_A, returnRequestId, acceptedQuantity, rejectedQuantity, evidence: "공급처 회신 메일", repliedAt: "2026-03-04T07:00:00.000Z", idempotencyKey: key() });
const dispatch = (api: Api, returnRequestId: string, quantity: number, actor = staff) =>
  api.dispatchReturn(actor, { tenantId: T_A, returnRequestId, quantity, dispatchedAt: "2026-03-04T07:10:00.000Z", referenceNumber: "TRK-1", idempotencyKey: key() });
const complete = (api: Api, returnRequestId: string, quantity: number, actor = staff) =>
  api.completeReturn(actor, { tenantId: T_A, returnRequestId, quantity, evidence: "공급처 수령 확인서", confirmedAt: "2026-03-04T07:20:00.000Z", idempotencyKey: key() });

describe("반품 회신·출고·완료 (Postgres 영속화)", () => {
  it("Staff도 공급처 회신·출고·완료를 기록하고, 거절된 수량은 처분 대기로 돌아오며, 미응답·미수락·미출고 수량 초과는 거부된다", async () => {
    const api = createPgDispositionApi({ pool: db.pool() });
    const c = await cancelledAllocation(6, 3, { initialStock: true });
    const request = await requestReturn(api, c.cancellationId, 3);

    expect(await codeOf(() => dispatch(api, request.id, 1))).toBe("BUSINESS_INVARIANT"); // 아직 수락 전
    expect(await codeOf(() => reply(api, request.id, 3, 1))).toBe("BUSINESS_INVARIANT"); // 요청 3권 초과
    expect(await codeOf(() => reply(api, request.id, 2, 1, { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await reply(api, request.id, 2, 1)).toMatchObject({ acceptedQuantity: 2, rejectedQuantity: 1, repliedBy: STAFF_A });

    expect((await intake(api, c.cancellationId, 1)).intake.quantity).toBe(1); // 거절된 1권은 다시 처분 대기
    expect(await codeOf(() => intake(api, c.cancellationId, 1))).toBe("BUSINESS_INVARIANT");

    expect(await codeOf(() => dispatch(api, request.id, 3))).toBe("BUSINESS_INVARIANT"); // 수락 2권뿐
    expect(await dispatch(api, request.id, 2)).toMatchObject({ quantity: 2, dispatchedBy: STAFF_A, referenceNumber: "TRK-1" });
    expect(await codeOf(() => complete(api, request.id, 3))).toBe("BUSINESS_INVARIANT"); // 출고 2권뿐
    expect(await complete(api, request.id, 2)).toMatchObject({ quantity: 2, confirmedBy: STAFF_A });
    expect(await codeOf(() => complete(api, request.id, 1))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => complete(api, "0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    expect(await num("select count(*)::int as n from public.ordering_return_completions where return_request_id = $1", [request.id])).toBe(1);
  });
});

describe("반품 예외·해소·재협의 (Postgres 영속화)", () => {
  it("출고한 수량만 예외로 신고하고, 해소된 회수 수량과 거절 수량은 처분 대기로 돌아오며, 재협의는 거절 수량만큼 한 번씩 가능하다", async () => {
    const api = createPgDispositionApi({ pool: db.pool() });
    const c = await cancelledAllocation(7, 3, { initialStock: true });
    const request = await requestReturn(api, c.cancellationId, 3);
    await reply(api, request.id, 2, 1);
    await dispatch(api, request.id, 2);
    const reportException = (quantity: number, kind = "LOST") =>
      api.reportReturnException(staff, { tenantId: T_A, returnRequestId: request.id, quantity, kind: kind as never, evidence: "택배사 분실 확인서", reportedAt: "2026-03-04T07:30:00.000Z", idempotencyKey: key() });
    const resolve = (exceptionId: string, quantity: number, outcome: "RECOVERED" | "RETURNED" = "RECOVERED") =>
      api.resolveReturnException(staff, { tenantId: T_A, returnExceptionId: exceptionId, outcome, quantity, evidence: "회수 후 검수 완료", resolvedAt: "2026-03-04T07:40:00.000Z", idempotencyKey: key() });
    const renegotiate = (quantity: number) =>
      api.renegotiateReturn(staff, { tenantId: T_A, originalRequestId: request.id, quantity, retryReason: "공급처 재협의", requestedAt: "2026-03-04T07:50:00.000Z", idempotencyKey: key() });

    expect(await codeOf(() => reportException(3))).toBe("BUSINESS_INVARIANT"); // 출고 2권뿐
    const exception = await reportException(1);
    expect(exception).toMatchObject({ quantity: 1, kind: "LOST", reportedBy: STAFF_A });
    expect(await codeOf(() => complete(api, request.id, 2))).toBe("BUSINESS_INVARIANT"); // 신고된 1권은 완료에서 빠진다
    expect((await complete(api, request.id, 1)).quantity).toBe(1);

    expect(await codeOf(() => resolve(exception.id, 2))).toBe("BUSINESS_INVARIANT");
    expect(await codeOf(() => resolve("0a000000-0000-4000-8000-00000000ffff", 1))).toBe("NOT_FOUND");
    expect(await resolve(exception.id, 1)).toMatchObject({ outcome: "RECOVERED", quantity: 1, returnRequestId: request.id });

    // 처분 대기: 취소 3 - (요청 3 - 거절 1 - 회수 1) = 2
    const retry = await renegotiate(1);
    expect(retry).toMatchObject({ retryOfRequestId: request.id, retryReason: "공급처 재협의", quantity: 1, supplierCode: "sup-a" });
    expect(await codeOf(() => renegotiate(1))).toBe("BUSINESS_INVARIANT"); // 거절 1권은 이미 재협의했다
    expect(await codeOf(() => intake(api, c.cancellationId, 2))).toBe("BUSINESS_INVARIANT"); // 재협의로 1권이 다시 묶였다
    expect((await intake(api, c.cancellationId, 1)).intake.quantity).toBe(1);
  });
});

describe("처분의 실제 동시성과 DB 방어 (두 독립 세션)", () => {
  it("마지막 1권을 편입과 반품 요청이 동시에 처분하면 하나만 성공한다", async () => {
    const c = await cancelledAllocation(4, 1, { initialStock: true });

    const results = await Promise.allSettled([
      intake(createPgDispositionApi({ pool: db.pool() }), c.cancellationId, 1),
      requestReturn(createPgDispositionApi({ pool: db.pool() }), c.cancellationId, 1),
    ]);

    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "OK"]);
    const disposed = (await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_stock_intakes where cancellation_id = $1", [c.cancellationId])) +
      (await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_return_requests where cancellation_id = $1", [c.cancellationId]));
    expect(disposed).toBe(1);
  });

  it("직접 SQL로도 처분 대기 수량을 넘겨 편입하거나 반품 요청할 수 없다", async () => {
    const c = await cancelledAllocation(5, 2, { initialStock: true });
    const conn = await db.connect();
    try {
      await conn.query(`insert into public.ordering_stock_intakes (tenant_id, cancellation_id, quantity, acted_by, acted_at) values ('${T_A}', '${c.cancellationId}', 1, 'raw', now())`);
      const over = (table: string, by: string) =>
        `insert into public.${table} (tenant_id, cancellation_id, quantity, ${by}, ${table === "ordering_stock_intakes" ? "acted_at" : "requested_at"}) values ('${T_A}', '${c.cancellationId}', 2, 'raw', now())`;
      expect(await sqlState(() => conn.query(over("ordering_stock_intakes", "acted_by")))).toBe("P0001");
      expect(await sqlState(() => conn.query(over("ordering_return_requests", "requested_by")))).toBe("P0001");
      await conn.query(`insert into public.ordering_return_requests (tenant_id, cancellation_id, quantity, requested_by, requested_at) values ('${T_A}', '${c.cancellationId}', 1, 'raw', now())`); // 남은 1권은 가능
    } finally {
      await conn.end();
    }
  });
});

describe("반품 후속의 DB 방어와 동시성", () => {
  it("직접 SQL로도 회신·출고·완료·예외·해소·재협의의 수량 불변식을 어길 수 없다", async () => {
    const api = createPgDispositionApi({ pool: db.pool() });
    const c = await cancelledAllocation(8, 3, { initialStock: true });
    const request = await requestReturn(api, c.cancellationId, 3);
    const conn = await db.connect();
    const q = (sql: string) => () => conn.query(sql);
    const R = request.id;
    try {
      const replyIns = (a: number, r: number) => `insert into public.ordering_return_replies (tenant_id, return_request_id, accepted_quantity, rejected_quantity, evidence, replied_by, replied_at) values ('${T_A}', '${R}', ${a}, ${r}, '근거', 'raw', now())`;
      const dispatchIns = (n: number) => `insert into public.ordering_return_dispatches (tenant_id, return_request_id, quantity, dispatched_by, dispatched_at) values ('${T_A}', '${R}', ${n}, 'raw', now())`;
      const completionIns = (n: number) => `insert into public.ordering_return_completions (tenant_id, return_request_id, quantity, evidence, confirmed_by, confirmed_at) values ('${T_A}', '${R}', ${n}, '근거', 'raw', now())`;
      const exceptionIns = (n: number) => `insert into public.ordering_return_exceptions (tenant_id, return_request_id, quantity, kind, evidence, reported_by, reported_at) values ('${T_A}', '${R}', ${n}, 'LOST', '근거', 'raw', now()) returning id`;
      expect(await sqlState(q(replyIns(3, 1)))).toBe("P0001"); // 요청 3권 초과
      await conn.query(replyIns(2, 1));
      expect(await sqlState(q(replyIns(1, 0)))).toBe("P0001"); // 이미 3권 모두 응답
      expect(await sqlState(q(dispatchIns(3)))).toBe("P0001"); // 수락 2권뿐
      await conn.query(dispatchIns(2));
      expect(await sqlState(q(completionIns(3)))).toBe("P0001"); // 출고 2권뿐
      expect(await sqlState(q(exceptionIns(3)))).toBe("P0001");
      const exceptionId = (await conn.query(exceptionIns(1))).rows[0].id as string;
      expect(await sqlState(q(completionIns(2)))).toBe("P0001"); // 신고된 1권은 완료에서 빠진다
      const resolutionIns = (n: number) => `insert into public.ordering_return_exception_resolutions (tenant_id, return_exception_id, outcome, quantity, evidence, resolved_by, resolved_at) values ('${T_A}', '${exceptionId}', 'RECOVERED', ${n}, '근거', 'raw', now())`;
      expect(await sqlState(q(resolutionIns(2)))).toBe("P0001");
      await conn.query(resolutionIns(1));
      const retryIns = (n: number) => `insert into public.ordering_return_requests (tenant_id, cancellation_id, quantity, requested_by, requested_at, retry_of_request_id, retry_reason) values ('${T_A}', '${c.cancellationId}', ${n}, 'raw', now(), '${R}', '재협의')`;
      expect(await sqlState(q(retryIns(2)))).toBe("P0001"); // 거절 1권뿐
      await conn.query(retryIns(1));
      expect(await sqlState(q(retryIns(1)))).toBe("P0001"); // 이미 재협의했다
      expect(await sqlState(q(`update public.ordering_return_replies set rejected_quantity = 0 where return_request_id = '${R}'`))).toBe("P0001"); // 추가 전용
    } finally {
      await conn.end();
    }
  });

  it("수락 3권을 두 세션이 동시에 2권씩 출고하면 하나만 성공하고, 같은 취소 물량에 대한 회신 동시 기록도 요청 수량을 넘지 못한다", async () => {
    const c = await cancelledAllocation(9, 3, { initialStock: true });
    const request = await requestReturn(createPgDispositionApi({ pool: db.pool() }), c.cancellationId, 3);

    const replies = await Promise.allSettled([reply(createPgDispositionApi({ pool: db.pool() }), request.id, 2, 0), reply(createPgDispositionApi({ pool: db.pool() }), request.id, 2, 0)]);
    expect(replies.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]); // 3권 요청에 2권씩 회신
    await reply(createPgDispositionApi({ pool: db.pool() }), request.id, 1, 0);

    const dispatches = await Promise.allSettled([dispatch(createPgDispositionApi({ pool: db.pool() }), request.id, 2), dispatch(createPgDispositionApi({ pool: db.pool() }), request.id, 2)]);
    expect(dispatches.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await num("select coalesce(sum(quantity), 0)::int as n from public.ordering_return_dispatches where return_request_id = $1", [request.id])).toBe(2);
  });
});
