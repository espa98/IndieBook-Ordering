import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCancellationApi } from "../../src/db/pgCancellationApi";
import { createPgDispositionApi } from "../../src/db/pgDispositionApi";
import { createPgFulfillmentApi } from "../../src/db/pgFulfillmentApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * R-01 취소 도서 처분·R-03 반품: 취소로 풀린 물량(배분 취소)의 처분 현황 목록. 취소 물량마다 8버킷 중 처분 대기·재고 편입·반품 보관·반품 출고·반품 완료를
 * 입고·편입·반품 요청·회신·출고·완료·예외 해소 기록에서 파생한다(`receiptBuckets`의 이동 규칙과 같다).
 * 시험은 실제 명령으로 만든 상태를 손계산과 대조한다.
 */
const T = "aaaaaaaa-0000-4000-8000-0000000000e9";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000ea";
const OWNER = "11111111-0000-4000-8000-0000000000e9";
const STAFF = "11111111-0000-4000-8000-0000000000eb";
const EX_STAFF = "11111111-0000-4000-8000-0000000000ec";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000ea";
const STRANGER = "99999999-0000-4000-8000-0000000000e9";
const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { userId: OWNER };
const staff = { userId: STAFF };

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
const key = () => `dp-${++seq}`;
const reads = () => createPgReadApi({ pool: db.pool() });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};

/** 입고 배분된 물량을 주문 전량 취소로 풀어 처분 대기(취소 물량) 하나를 만든다 */
async function cancelledAllocation(book: number, quantity: number) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const draft = await orders.createOrder(owner, { tenantId: T, idempotencyKey: key(), lines: [{ bookId: BOOK(book), quantity, unitPriceKrw: "15000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  await q(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', 1, '초기 재고', 'seed', now())`, [T, BOOK(book)]);
  const poId = (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup-a', 'SENT', 3) returning id`, [T]))[0].id as string;
  const poLineId = (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, $4) returning id`, [T, poId, BOOK(book), quantity]))[0].id as string;
  await q(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, $5)`, [T, poLineId, order.id, lineId, quantity]);
  const receiving = createPgReceivingApi({ pool: db.pool() });
  const receipt = await receiving.receiveGoods(staff, { tenantId: T, purchaseOrderId: poId, poLineId, normalQuantity: quantity, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: key() } as never);
  const allocation = await receiving.allocateReceipt(staff, { tenantId: T, receiptId: receipt.id, orderId: order.id, orderLineId: lineId, quantity, allocatedAt: "2026-03-04T06:40:00.000Z", idempotencyKey: key() } as never);
  const cancel = await createPgFulfillmentApi({ pool: db.pool() }).requestOrderCancellation(staff, {
    tenantId: T, orderId: order.id, orderLineId: lineId, quantity, reason: "고객이 취소를 요청", expectedVersion: 2, requestedAt: "2026-03-04T06:45:00.000Z", idempotencyKey: key(),
  });
  const cancellations = createPgCancellationApi({ pool: db.pool() });
  await cancellations.decideOrderCancellation(owner, { tenantId: T, requestId: cancel.id, decision: "APPROVED", decidedAt: "2026-03-04T06:47:00.000Z", idempotencyKey: key() });
  await cancellations.applyOrderCancellation(owner, { tenantId: T, requestId: cancel.id, appliedAt: "2026-03-04T06:49:00.000Z", idempotencyKey: key() });
  const cancellationId = (await q("select id from public.ordering_allocation_cancellations where allocation_id = $1", [allocation.id]))[0].id as string;
  return { cancellationId, orderId: order.id as string, receiptId: receipt.id as string, bookKey: BOOK(book) };
}
const ids: Record<string, string> = {};
const meta: Record<string, { orderId: string; receiptId: string; bookKey: string }> = {};

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);
  for (let n = 1; n <= 6; n++) {
    await q(`insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, $3, 10000, 'MANUAL', '시험', 'seed', now())`, [BOOK(n), T, `책 ${n}`]);
  }
  const disposition = createPgDispositionApi({ pool: db.pool() });
  const make = async (name: string, book: number, quantity: number) => {
    const c = await cancelledAllocation(book, quantity);
    ids[name] = c.cancellationId;
    meta[name] = { orderId: c.orderId, receiptId: c.receiptId, bookKey: c.bookKey };
    return c;
  };
  // C1: 5권 취소 → 재고 편입 2 (처분 대기 3, 편입 2)
  await make("C1", 1, 5);
  await disposition.transferCancelledToStock(owner, { tenantId: T, cancellationId: ids.C1!, quantity: 2, actedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() });
  // C2: 4권 취소 → 반품 요청 4 → 회신(수락 3·거절 1) → 출고 2 → 완료 1 → 예외 1(분실) → 회수 해소 1
  await make("C2", 2, 4);
  const request = await disposition.requestReturn(owner, { tenantId: T, cancellationId: ids.C2!, quantity: 4, requestedAt: "2026-03-04T06:56:00.000Z", idempotencyKey: key() });
  await disposition.recordReturnReply(owner, { tenantId: T, returnRequestId: request.id, acceptedQuantity: 3, rejectedQuantity: 1, evidence: "회신", repliedAt: "2026-03-04T07:00:00.000Z", idempotencyKey: key() });
  await disposition.dispatchReturn(owner, { tenantId: T, returnRequestId: request.id, quantity: 2, dispatchedAt: "2026-03-04T07:10:00.000Z", referenceNumber: "TRK-1", idempotencyKey: key() });
  await disposition.completeReturn(owner, { tenantId: T, returnRequestId: request.id, quantity: 1, evidence: "수령 확인", confirmedAt: "2026-03-04T07:20:00.000Z", idempotencyKey: key() });
  const exception = await disposition.reportReturnException(owner, { tenantId: T, returnRequestId: request.id, quantity: 1, kind: "LOST" as never, evidence: "분실 확인", reportedAt: "2026-03-04T07:30:00.000Z", idempotencyKey: key() });
  await disposition.resolveReturnException(owner, { tenantId: T, returnExceptionId: exception.id, outcome: "RECOVERED" as never, quantity: 1, evidence: "회수", resolvedAt: "2026-03-04T07:40:00.000Z", idempotencyKey: key() });
  // C3: 2권 취소, 손대지 않음
  await make("C3", 3, 2);
  // C4: 1권 취소 → 전량 재고 편입(처분 완료)
  await make("C4", 4, 1);
  await disposition.transferCancelledToStock(owner, { tenantId: T, cancellationId: ids.C4!, quantity: 1, actedAt: "2026-03-04T06:55:00.000Z", idempotencyKey: key() });
}, 300_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("취소 물량 처분 현황 (R-01·R-03)", () => {
  it("취소 물량마다 처분 대기·재고 편입·반품 보관·반품 출고·반품 완료 수량을 원장에서 파생해 보여 준다(합계는 취소 수량과 같다)", async () => {
    const page = await reads().listAllocationCancellations({ userId: STAFF }, { tenantId: T });
    expect(page.items).toHaveLength(4);
    const by = Object.fromEntries(page.items.map((i) => [i.id, i]));
    expect(by[ids.C1!]).toEqual({
      id: ids.C1, receiptId: meta.C1!.receiptId, orderId: meta.C1!.orderId, orderLineId: expect.any(String), bookKey: meta.C1!.bookKey, quantity: 5, cancelledAt: "2026-03-04T06:49:00.000Z",
      pendingDispositionQuantity: 3, stockTransferredQuantity: 2, returnHeldQuantity: 0, returnDispatchedQuantity: 0, returnedFinalQuantity: 0,
    });
    // C2: 요청 4 → 거절 1(대기로 복귀) → 출고 2 → 완료 1 → 예외 해소 회수 1(대기로 복귀): 대기 2, 보관 1, 출고 0, 완료 1
    expect(by[ids.C2!]).toMatchObject({ quantity: 4, pendingDispositionQuantity: 2, stockTransferredQuantity: 0, returnHeldQuantity: 1, returnDispatchedQuantity: 0, returnedFinalQuantity: 1 });
    expect(by[ids.C3!]).toMatchObject({ quantity: 2, pendingDispositionQuantity: 2, stockTransferredQuantity: 0 });
    expect(by[ids.C4!]).toMatchObject({ quantity: 1, pendingDispositionQuantity: 0, stockTransferredQuantity: 1 });
    for (const item of page.items) {
      expect(item.pendingDispositionQuantity + item.stockTransferredQuantity + item.returnHeldQuantity + item.returnDispatchedQuantity + item.returnedFinalQuantity, item.id).toBe(item.quantity);
    }
  });

  it("open=true는 처분이 끝나지 않은 물량(대기·보관·출고가 남음)만 보여 주고 커서 페이지네이션이 이어진다", async () => {
    const ordered = (await q("select id from public.ordering_allocation_cancellations where tenant_id = $1 order by cancelled_at desc, id desc", [T])).map((r) => r.id as string);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reads().listAllocationCancellations(owner, { tenantId: T, limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ordered);

    const open = await reads().listAllocationCancellations(owner, { tenantId: T, open: true });
    expect(open.items.map((i) => i.id).sort()).toEqual([ids.C1!, ids.C2!, ids.C3!].sort()); // C4는 처분 완료
    const first = await reads().listAllocationCancellations(owner, { tenantId: T, open: true, limit: 2 });
    const second = await reads().listAllocationCancellations(owner, { tenantId: T, open: true, limit: 2, cursor: first.nextCursor });
    expect([...first.items, ...second.items].map((i) => i.id)).toEqual(open.items.map((i) => i.id));
  });

  it("잘못된 limit·cursor·open은 VALIDATION_ERROR, 비멤버·비활성은 FORBIDDEN(검증보다 먼저), 다른 서점 물량은 섞이지 않는다", async () => {
    for (const bad of [{ limit: 0 }, { cursor: "%%%" }, { open: "yes" as never }]) {
      expect(await codeOf(() => reads().listAllocationCancellations(owner, { tenantId: T, ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().listAllocationCancellations({ userId }, { tenantId: T, limit: 0 })), userId).toBe("FORBIDDEN");
    expect((await reads().listAllocationCancellations({ userId: OTHER_OWNER }, { tenantId: OTHER_T })).items).toEqual([]);
  });
});
