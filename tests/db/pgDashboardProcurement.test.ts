import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 대시보드의 부분입고·미입고 잔량(DASH-003): 전달된(SENT·ACKNOWLEDGED) 발주의 품목마다
 * 유효 수량 = 발주 수량 − 품절 회신 − 수락된 취소, 순입고 = 검수 정상 − 검수 정정, 잔량 = max(0, 유효 − 순입고).
 * 입고 가드(`007_receiving.sql`)가 쓰는 규칙과 같다.
 */
const T = "aaaaaaaa-0000-4000-8000-0000000000d7";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000d8";
const OWNER = "11111111-0000-4000-8000-0000000000d7";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000d8";
const T0 = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const po = async (tenant: string, status: string) => (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version) values ($1, 'sup', $2, 3) returning id`, [tenant, status]))[0].id as string;
const line = async (tenant: string, poId: string, quantity: number) => (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, 'b', $3) returning id`, [tenant, poId, quantity]))[0].id as string;
const receipt = async (tenant: string, poId: string, lineId: string, normal: number) =>
  (await q(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, inspected_by, received_at) values ($1, $2, $3, $4, 'u', $5) returning id`, [tenant, poId, lineId, normal, T0]))[0].id as string;

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER]);

  // PO1(SENT): A 10권 중 4권 입고(부분, 잔량 6), B 5권 미입고(잔량 5)
  const po1 = await po(T, "SENT");
  const a = await line(T, po1, 10);
  await line(T, po1, 5);
  await receipt(T, po1, a, 4);
  // PO2(ACKNOWLEDGED): C 8권 중 품절 회신 3 → 유효 5, 5권 입고 → 잔량 0(제외)
  const po2 = await po(T, "ACKNOWLEDGED");
  const c = await line(T, po2, 8);
  await q(`insert into public.ordering_po_replies (tenant_id, purchase_order_id, po_line_id, kind, quantity, evidence, replied_at) values ($1, $2, $3, 'OUT_OF_STOCK', 3, '품절 회신', $4)`, [T, po2, c, T0]);
  await receipt(T, po2, c, 5);
  // PO3(SENT): D 6권 중 수락된 취소 2 → 유효 4, 1권 입고 후 1권 정정 → 순입고 0 → 미입고, 잔량 4
  const po3 = await po(T, "SENT");
  const d = await line(T, po3, 6);
  const request = (await q(`insert into public.ordering_po_cancellation_requests (tenant_id, purchase_order_id, po_line_id, quantity, reason) values ($1, $2, $3, 2, '취소') returning id`, [T, po3, d]))[0].id as string;
  await q(`insert into public.ordering_po_cancellation_responses (tenant_id, purchase_order_id, po_line_id, request_id, accepted_quantity, rejected_quantity, evidence, replied_at) values ($1, $2, $3, $4, 2, 0, '수락', $5)`, [T, po3, d, request, T0]);
  const rd = await receipt(T, po3, d, 1);
  await q(`insert into public.ordering_receipt_corrections (tenant_id, receipt_id, quantity, reason, corrected_by, corrected_at) values ($1, $2, 1, '정정', 'u', $3)`, [T, rd, T0]);
  // 전달 전·취소·종결 발주는 세지 않는다
  for (const status of ["DRAFT", "READY", "CANCELLED", "CLOSED"]) await line(T, await po(T, status), 7);
  // 다른 서점
  await line(OTHER_T, await po(OTHER_T, "SENT"), 9);
}, 240_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("대시보드 부분입고·미입고 잔량 (DASH-003)", () => {
  it("전달된 발주 품목의 미입고·부분입고 건수와 잔량 합계를 입고 가드와 같은 규칙으로 센다", async () => {
    const dashboard = await createPgReadApi({ pool: db.pool() }).getDashboard({ userId: OWNER }, { tenantId: T });
    expect(dashboard.procurement).toEqual({ notReceivedLines: 2, partiallyReceivedLines: 1, remainingQuantity: 15 }); // B 5 + D 4 + A 6
  });

  it("다른 서점의 발주는 섞이지 않는다", async () => {
    const dashboard = await createPgReadApi({ pool: db.pool() }).getDashboard({ userId: OTHER_OWNER }, { tenantId: OTHER_T });
    expect(dashboard.procurement).toEqual({ notReceivedLines: 1, partiallyReceivedLines: 0, remainingQuantity: 9 });
  });
});
