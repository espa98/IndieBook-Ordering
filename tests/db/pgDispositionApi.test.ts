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
