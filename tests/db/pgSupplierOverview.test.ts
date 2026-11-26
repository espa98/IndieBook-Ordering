import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** DASH-006 공급처별 발주·입고 현황: 공급처마다 발주 상태별 건수, 전달된 발주의 잔량·지연, 마지막 전달 시각 */
const T = "aaaaaaaa-0000-4000-8000-0000000000a9";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000aa";
const OWNER = "11111111-0000-4000-8000-0000000000a9";
const STAFF = "11111111-0000-4000-8000-0000000000ab";
const EX_STAFF = "11111111-0000-4000-8000-0000000000ac";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000aa";
const STRANGER = "99999999-0000-4000-8000-0000000000a9";
const T0 = "2026-03-04T06:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const reads = () => createPgReadApi({ pool: db.pool() });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const po = async (tenant: string, supplier: string, status: string, deliveredDaysAgo?: number) =>
  (await q(`insert into public.ordering_purchase_orders (tenant_id, supplier_code, status, version, delivery) values ($1, $2, $3, 3, $4::jsonb) returning id`, [
    tenant, supplier, status, deliveredDaysAgo === undefined ? null : JSON.stringify({ method: "EMAIL", deliveredAt: daysAgo(deliveredDaysAgo), recordedAt: daysAgo(deliveredDaysAgo), deliveredBy: "u", poVersion: 2 }),
  ]))[0].id as string;
const line = async (tenant: string, poId: string, quantity: number) => (await q(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, 'b', $3) returning id`, [tenant, poId, quantity]))[0].id as string;
const receipt = async (tenant: string, poId: string, lineId: string, normal: number) =>
  (await q(`insert into public.ordering_goods_receipts (tenant_id, purchase_order_id, po_line_id, normal_quantity, inspected_by, received_at) values ($1, $2, $3, $4, 'u', $5) returning id`, [tenant, poId, lineId, normal, T0]))[0].id as string;
let deliveredAlpha = "";

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);
  await q(`insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel) values ($1, 'alpha', true, '알파 도매', 'EMAIL'), ($1, 'beta', true, '베타 유통', 'WEB'), ($1, 'gamma', false, '감마 서적', 'PHONE'), ($2, 'alpha', true, '남의 알파', 'EMAIL')`, [T, OTHER_T]);

  // alpha: PO1(SENT, 10일 전) A 10권 중 4 입고(잔량 6)·B 5권 미입고(잔량 5), PO2(ACK, 20일 전) C 8권 품절 3 → 5 입고(잔량 0), 초안 1건
  const po1 = await po(T, "alpha", "SENT", 10);
  deliveredAlpha = new Date((await q("select delivery->>'deliveredAt' as d from public.ordering_purchase_orders where id = $1", [po1]))[0].d as string).toISOString(); // 저장된 값(시험이 만든 시각과 밀리초가 다를 수 있다)
  const a = await line(T, po1, 10);
  await line(T, po1, 5);
  await receipt(T, po1, a, 4);
  const po2 = await po(T, "alpha", "ACKNOWLEDGED", 20);
  const c = await line(T, po2, 8);
  await q(`insert into public.ordering_po_replies (tenant_id, purchase_order_id, po_line_id, kind, quantity, evidence, replied_at) values ($1, $2, $3, 'OUT_OF_STOCK', 3, '품절', $4)`, [T, po2, c, T0]);
  await receipt(T, po2, c, 5);
  await po(T, "alpha", "DRAFT");
  // beta: PO3(SENT, 2일 전) D 6권, 수락된 취소 2 → 유효 4, 입고 1 후 정정 1 → 잔량 4. 취소된 발주 1건
  const po3 = await po(T, "beta", "SENT", 2);
  const d = await line(T, po3, 6);
  const request = (await q(`insert into public.ordering_po_cancellation_requests (tenant_id, purchase_order_id, po_line_id, quantity, reason) values ($1, $2, $3, 2, '취소') returning id`, [T, po3, d]))[0].id as string;
  await q(`insert into public.ordering_po_cancellation_responses (tenant_id, purchase_order_id, po_line_id, request_id, accepted_quantity, rejected_quantity, evidence, replied_at) values ($1, $2, $3, $4, 2, 0, '수락', $5)`, [T, po3, d, request, T0]);
  const rd = await receipt(T, po3, d, 1);
  await q(`insert into public.ordering_receipt_corrections (tenant_id, receipt_id, quantity, reason, corrected_by, corrected_at) values ($1, $2, 1, '정정', 'u', $3)`, [T, rd, T0]);
  await line(T, await po(T, "beta", "CANCELLED"), 3);
  // 다른 서점
  await line(OTHER_T, await po(OTHER_T, "alpha", "SENT", 40), 9);
}, 240_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("공급처별 발주·입고 현황 (DASH-006)", () => {
  it("공급처(비활성 포함)를 코드순으로 발주 상태별 건수·전달된 발주의 잔량·지연·마지막 전달 시각과 함께 보여 준다", async () => {
    const { items } = await reads().listSupplierOverview({ userId: STAFF }, { tenantId: T });
    expect(items.map((i) => i.code)).toEqual(["alpha", "beta", "gamma"]);
    const by = Object.fromEntries(items.map((i) => [i.code, i]));
    expect(by.alpha).toEqual({
      code: "alpha", name: "알파 도매", active: true, orderChannel: "EMAIL",
      purchaseOrders: { draft: 1, ready: 0, sent: 1, acknowledged: 1, cancelled: 0, closed: 0 },
      openRemainingQuantity: 11, delayedLines: 2, delayedQuantity: 11, lastDeliveredAt: deliveredAlpha,
    });
    expect(by.beta).toMatchObject({
      name: "베타 유통", purchaseOrders: { draft: 0, ready: 0, sent: 1, acknowledged: 0, cancelled: 1, closed: 0 },
      openRemainingQuantity: 4, delayedLines: 0, delayedQuantity: 0,
    });
    expect(typeof by.beta?.lastDeliveredAt).toBe("string");
    expect(by.gamma).toEqual({
      code: "gamma", name: "감마 서적", active: false, orderChannel: "PHONE",
      purchaseOrders: { draft: 0, ready: 0, sent: 0, acknowledged: 0, cancelled: 0, closed: 0 }, openRemainingQuantity: 0, delayedLines: 0, delayedQuantity: 0,
    });
    expect(by.gamma).not.toHaveProperty("lastDeliveredAt");
  });

  it("delayDays로 지연 기준을 바꾸고(1~365 정수), 다른 서점의 공급처·발주는 섞이지 않는다", async () => {
    const read = (userId: string, tenantId: string, extra: Record<string, unknown> = {}) => reads().listSupplierOverview({ userId }, { tenantId, ...extra } as never);
    expect((await read(OWNER, T, { delayDays: 1 })).items.find((i) => i.code === "beta")).toMatchObject({ delayedLines: 1, delayedQuantity: 4 });
    expect((await read(OWNER, T, { delayDays: 30 })).items.find((i) => i.code === "alpha")).toMatchObject({ delayedLines: 0 });
    for (const bad of [0, 366, 1.5, "7"]) expect(await codeOf(() => read(OWNER, T, { delayDays: bad })), String(bad)).toBe("VALIDATION_ERROR");
    const theirs = (await read(OTHER_OWNER, OTHER_T)).items;
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ name: "남의 알파", purchaseOrders: { sent: 1 }, openRemainingQuantity: 9, delayedLines: 1 });
  });

  it("비멤버·비활성은 FORBIDDEN(검증보다 먼저)이다", async () => {
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().listSupplierOverview({ userId }, { tenantId: T, delayDays: 0 } as never)), userId).toBe("FORBIDDEN");
  });
});
