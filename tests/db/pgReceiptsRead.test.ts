import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { createPgReceivingApi } from "../../src/db/pgReceivingApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** O-07 입고 현황·O-07-02 배분: 입고 목록(커서 페이지네이션, 미배분 필터)과 상세(배분·정정·불량·초과 이력). 읽기 전용 */
const T = "aaaaaaaa-0000-4000-8000-0000000000c5";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000c6";
const OWNER = "11111111-0000-4000-8000-0000000000c5";
const STAFF = "11111111-0000-4000-8000-0000000000c7";
const EX_STAFF = "11111111-0000-4000-8000-0000000000c8";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000c6";
const STRANGER = "99999999-0000-4000-8000-0000000000c5";
const BOOK = "b0000000-0000-4000-8000-0000000000c5";
const at = (n: number) => `2026-03-0${n}T06:30:00.000Z`;

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
const key = () => `rr-${++seq}`;
const owner = { userId: OWNER };
const reads = () => createPgReadApi({ pool: db.pool() });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};

async function receive(normal: number, receivedAt: string, extra: { damaged?: number; excess?: number } = {}) {
  const orders = createPgOrderApi({ pool: db.pool() });
  const ordered = normal + (extra.excess ?? 0) > normal ? normal : normal;
  const draft = await orders.createOrder(owner, { tenantId: T, idempotencyKey: key(), lines: [{ bookId: BOOK, quantity: ordered, unitPriceKrw: "10000" }] });
  const order = await orders.confirmOrder(owner, { tenantId: T, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
  const lineId = order.lines[0]!.lineId;
  const poId = (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup', 'SENT', 3) returning id`, [T]))[0].id as string;
  const poLineId = (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, $3, $4) returning id`, [T, poId, BOOK, ordered]))[0].id as string;
  await q(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, gen_random_uuid(), $3, $4, $5)`, [T, poLineId, order.id, lineId, ordered]);
  const receiving = createPgReceivingApi({ pool: db.pool() });
  const receipt = await receiving.receiveGoods(owner, {
    tenantId: T, purchaseOrderId: poId, poLineId, normalQuantity: normal, damagedQuantity: extra.damaged ?? 0, misdeliveredQuantity: 0, receivedAt, idempotencyKey: key(),
  } as never);
  return { receiving, receiptId: receipt.id as string, orderId: order.id as string, lineId, poId };
}
const ids: Record<string, string> = {};
const pos: Record<string, string> = {};

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);
  await q(`insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '책', '{}', null, 10000, 'MANUAL', '시험', 'seed', now())`, [BOOK, T]);

  // A: 정상 5 → 배분 2 → 해제 1 (순배분 1, 미배분 4), 불량 1
  const a = await receive(5, at(1), { damaged: 1 });
  const allocA = await a.receiving.allocateReceipt(owner, { tenantId: T, receiptId: a.receiptId, orderId: a.orderId, orderLineId: a.lineId, quantity: 2, allocatedAt: at(1), idempotencyKey: key() } as never);
  await a.receiving.releaseAllocation(owner, { tenantId: T, allocationId: allocA.id, quantity: 1, reason: "변경", releasedAt: at(1), idempotencyKey: key() } as never);
  // B: 정상 3 → 전량 배분 (미배분 0)
  const b = await receive(3, at(2));
  await b.receiving.allocateReceipt(owner, { tenantId: T, receiptId: b.receiptId, orderId: b.orderId, orderLineId: b.lineId, quantity: 3, allocatedAt: at(2), idempotencyKey: key() } as never);
  // C: 정상 4 → 검수 정정 1 (미배분 3)
  const c = await receive(4, at(3));
  await c.receiving.correctReceipt(owner, { tenantId: T, receiptId: c.receiptId, quantity: 1, reason: "검수 수량 정정", correctedAt: at(3), idempotencyKey: key() } as never);
  // D: 정상 2, 배분 없음
  const d = await receive(2, at(4));
  Object.assign(ids, { A: a.receiptId, B: b.receiptId, C: c.receiptId, D: d.receiptId });
  Object.assign(pos, { A: a.poId, B: b.poId, C: c.poId, D: d.poId });

  // 다른 서점 입고 한 건(직접 시드)
  const otherPo = (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup', 'SENT', 3) returning id`, [OTHER_T]))[0].id as string;
  const otherLine = (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, 'x', 1) returning id`, [OTHER_T, otherPo]))[0].id as string;
  ids.OTHER = (await q(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, inspected_by, received_at) values ($1, $2, $3, 1, 'u', $4) returning id`, [OTHER_T, otherPo, otherLine, at(5)]))[0].id as string;
}, 240_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("입고 목록 (O-07)", () => {
  it("최신 입고 순으로 수량(검수·정정·불량·배분·미배분)과 도서를 보여 준다. 다른 서점 입고는 나오지 않는다", async () => {
    const page = await reads().listReceipts({ userId: STAFF }, { tenantId: T });
    expect(page.items.map((i) => i.id)).toEqual([ids.D, ids.C, ids.B, ids.A]);
    expect(page.nextCursor).toBeUndefined();
    const byId = Object.fromEntries(page.items.map((i) => [i.id, i]));
    expect(byId[ids.A!]).toEqual({
      id: ids.A, purchaseOrderId: pos.A, poLineId: expect.any(String), bookKey: BOOK, receivedAt: at(1),
      normalQuantity: 5, correctedQuantity: 0, damagedQuantity: 1, misdeliveredQuantity: 0, excessQuantity: 0,
      allocatedQuantity: 1, unallocatedQuantity: 4,
    });
    expect(byId[ids.B!]).toMatchObject({ allocatedQuantity: 3, unallocatedQuantity: 0 });
    expect(byId[ids.C!]).toMatchObject({ normalQuantity: 4, correctedQuantity: 1, allocatedQuantity: 0, unallocatedQuantity: 3 });
    expect(byId[ids.D!]).toMatchObject({ allocatedQuantity: 0, unallocatedQuantity: 2 });
    expect(page.items.some((i) => i.id === ids.OTHER)).toBe(false);
  });

  it("커서로 끝까지 걸으면 전부 한 번씩 나오고, unallocated=true는 미배분이 남은 입고만, purchaseOrderId는 그 발주의 입고만 보여 준다", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reads().listReceipts(owner, { tenantId: T, limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([ids.D, ids.C, ids.B, ids.A]);

    const only = await reads().listReceipts(owner, { tenantId: T, unallocated: true, limit: 2 });
    expect(only.items.map((i) => i.id)).toEqual([ids.D, ids.C]);
    expect((await reads().listReceipts(owner, { tenantId: T, unallocated: true, limit: 2, cursor: only.nextCursor })).items.map((i) => i.id)).toEqual([ids.A]);
    expect((await reads().listReceipts(owner, { tenantId: T, purchaseOrderId: pos.B })).items.map((i) => i.id)).toEqual([ids.B]);
    expect((await reads().listReceipts(owner, { tenantId: T, purchaseOrderId: "aaaaaaaa-0000-4000-8000-0000000000ff" })).items).toEqual([]);
  });

  it("잘못된 limit·cursor·purchaseOrderId·unallocated는 VALIDATION_ERROR, 비멤버·비활성은 FORBIDDEN(검증보다 먼저)", async () => {
    for (const bad of [{ limit: 0 }, { limit: 101 }, { cursor: "%%%" }, { purchaseOrderId: "not-uuid" }, { unallocated: "yes" as never }]) {
      expect(await codeOf(() => reads().listReceipts(owner, { tenantId: T, ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().listReceipts({ userId }, { tenantId: T, limit: 0 })), userId).toBe("FORBIDDEN");
  });
});

describe("입고 상세 (O-07-02)", () => {
  it("입고 상세는 배분(해제 수량 포함)·정정·불량 처리·초과 결정 이력을 보여 주고 증빙 원문은 싣지 않는다", async () => {
    const a = await reads().getReceipt(owner, { tenantId: T, receiptId: ids.A! });
    expect(a).toMatchObject({ id: ids.A, normalQuantity: 5, allocatedQuantity: 1, unallocatedQuantity: 4 });
    expect(a.allocations).toEqual([{ id: expect.any(String), orderId: expect.any(String), orderLineId: expect.any(String), quantity: 2, releasedQuantity: 1, allocatedAt: at(1), allocatedBy: OWNER }]);
    expect(a.corrections).toEqual([]);
    const c = await reads().getReceipt(owner, { tenantId: T, receiptId: ids.C! });
    expect(c.corrections).toEqual([{ id: expect.any(String), quantity: 1, reason: "검수 수량 정정", correctedAt: at(3), correctedBy: OWNER }]);

    // 불량 처리·초과 결정을 직접 시드해 상세에 나오는지 본다(증빙은 응답에 없다)
    await q(`insert into public.ordering_receipt_defect_resolutions (tenant_id, receipt_id, purchase_order_id, kind, quantity, outcome, evidence, resolved_by, resolved_at) values ($1, $2, $3, 'DAMAGED', 1, 'DISCARDED', '비밀 증빙 문서 123', 'u', $4)`, [T, ids.A, pos.A, at(2)]);
    // 초과 입고가 있는 입고(E)를 직접 시드한다(목록 시험 뒤에 만들어 앞의 목록 기대를 바꾸지 않는다)
    const poLineA = (await q("select po_line_id from public.ordering_goods_receipts where id = $1", [ids.A]))[0].po_line_id as string;
    const excessReceipt = (await q(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, excess_quantity, inspected_by, received_at) values ($1, $2, $3, 0, 2, 'u', $4) returning id`, [T, pos.A, poLineA, at(6)]))[0].id as string;
    await q(`insert into public.ordering_excess_decisions (tenant_id, receipt_id, decision, quantity, reason, decided_by, decided_at) values ($1, $2, 'APPROVED', 1, '재고 편입 승인', 'u', $3)`, [T, excessReceipt, at(6)]);
    const withFollowUp = await reads().getReceipt(owner, { tenantId: T, receiptId: ids.A! });
    const excessDetail = await reads().getReceipt(owner, { tenantId: T, receiptId: excessReceipt });
    expect(withFollowUp.defectResolutions).toEqual([{ id: expect.any(String), kind: "DAMAGED", quantity: 1, outcome: "DISCARDED", resolvedAt: at(2), resolvedBy: "u" }]);
    expect(excessDetail).toMatchObject({ normalQuantity: 0, excessQuantity: 2, unallocatedQuantity: 0 });
    expect(excessDetail.excessDecisions).toEqual([{ id: expect.any(String), decision: "APPROVED", quantity: 1, reason: "재고 편입 승인", decidedAt: at(6), decidedBy: "u" }]);
    expect(JSON.stringify([withFollowUp, excessDetail])).not.toContain("비밀 증빙");
  });

  it("다른 서점·없는 입고·UUID가 아닌 ID는 같은 NOT_FOUND이고, 비멤버는 FORBIDDEN", async () => {
    for (const receiptId of [ids.OTHER!, "aaaaaaaa-0000-4000-8000-0000000000ff", "not-uuid"]) {
      expect(await codeOf(() => reads().getReceipt(owner, { tenantId: T, receiptId })), receiptId).toBe("NOT_FOUND");
    }
    expect(await codeOf(() => reads().getReceipt({ userId: STRANGER }, { tenantId: T, receiptId: ids.A! }))).toBe("FORBIDDEN");
  });
});
