import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 대시보드의 미배분 입고(DASH-008): 입고마다 정상 순량(검수 − 검수 정정)에서 배분을 빼고 배분 해제를 더한 UNALLOCATED 버킷의 합.
 * 실제 입고·배분·해제·정정 명령으로 만든 상태를 손으로 계산한 값과 대조하고, 도메인 `receiptBalances`와 같은 규칙인지도 본다.
 */
const T = "aaaaaaaa-0000-4000-8000-0000000000b5";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000b6";
const OWNER = "11111111-0000-4000-8000-0000000000b5";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000b6";
const BOOK = "b0000000-0000-4000-8000-0000000000b5";
const T0 = "2026-03-04T06:30:00.000Z";

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
const key = () => `rc-${++seq}`;
const owner = { userId: OWNER };

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '책', '{}', null, 10000, 'MANUAL', '시험', 'seed', now())`, [BOOK, T]);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

/** 주문 하나(수량 N)와 그 발주 연결을 만들고, 정상 수량 `normal`로 입고한다 */
async function receive(normal: number, orderedQty: number) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T, idempotencyKey: key(), lines: [{ bookId: BOOK, quantity: orderedQty, unitPriceKrw: "10000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  const poId = (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup', 'SENT', 3) returning id`, [T]))[0].id as string;
  const poLineId = (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, $4) returning id`, [T, poId, BOOK, orderedQty]))[0].id as string;
  await q(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, $5)`, [T, poLineId, order.id, lineId, orderedQty]);
  const receiving = createPgReceivingApi({ pool: db.pool() });
  const receipt = await receiving.receiveGoods(owner, { tenantId: T, purchaseOrderId: poId, poLineId, normalQuantity: normal, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: T0, idempotencyKey: key() } as never);
  return { receiving, receiptId: receipt.id as string, orderId: order.id as string, lineId };
}

describe("대시보드 미배분 입고 집계 (DASH-008)", () => {
  it("입고별 미배분량(정상 − 정정 − 배분 + 해제)을 합산하고, 미배분이 남은 입고 수를 센다", async () => {
    // 입고 A: 정상 5 → 배분 2 → 해제 1 → 미배분 4
    const a = await receive(5, 5);
    const allocA = await a.receiving.allocateReceipt(owner, { tenantId: T, receiptId: a.receiptId, orderId: a.orderId, orderLineId: a.lineId, quantity: 2, allocatedAt: T0, idempotencyKey: key() } as never);
    await a.receiving.releaseAllocation(owner, { tenantId: T, allocationId: allocA.id, quantity: 1, reason: "변경", releasedAt: T0, idempotencyKey: key() } as never);
    // 입고 B: 정상 3 → 전량 배분 → 미배분 0 (집계에서 빠진다)
    const b = await receive(3, 3);
    await b.receiving.allocateReceipt(owner, { tenantId: T, receiptId: b.receiptId, orderId: b.orderId, orderLineId: b.lineId, quantity: 3, allocatedAt: T0, idempotencyKey: key() } as never);
    // 입고 C: 정상 4 → 검수 정정 1 → 미배분 3
    const c = await receive(4, 4);
    await c.receiving.correctReceipt(owner, { tenantId: T, receiptId: c.receiptId, quantity: 1, reason: "검수 수량 정정", correctedAt: T0, idempotencyKey: key() } as never);
    // 입고 D: 아직 아무 배분도 없음 → 미배분 2
    await receive(2, 2);

    const dashboard = await createPgReadApi({ pool: db.pool() }).getDashboard(owner, { tenantId: T });
    expect(dashboard.receipts).toEqual({ unallocatedReceipts: 3, unallocatedQuantity: 9 }); // A 4 + C 3 + D 2
  });

  it("다른 서점의 입고는 섞이지 않는다", async () => {
    expect((await createPgReadApi({ pool: db.pool() }).getDashboard({ userId: OTHER_OWNER }, { tenantId: OTHER_T })).receipts).toEqual({ unallocatedReceipts: 0, unallocatedQuantity: 0 });
  });
});
