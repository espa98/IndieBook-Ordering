import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCatalogApi } from "../../src/db/pgCatalogApi";
import { createPgNotificationApi } from "../../src/db/pgNotificationApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgPaymentApi } from "../../src/db/pgPaymentApi";
import { createPgStockApi } from "../../src/db/pgStockApi";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const EX_STAFF = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false), ($5, $6, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, EX_STAFF, T_B, OWNER_B],
  );
  for (let n = 1; n <= 10; n++) {
    await c.query(`insert into public.ordering_books (id, tenant_id, title, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, $3, 10000, 'MANUAL', '시험', 'seed', now())`, [`b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T_A, `재고 책 ${n}`]);
  }
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const staff = { userId: STAFF_A };
let seq = 0;
const key = () => `r-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const read = () => createPgReadApi({ pool: db.pool() });
const addBook = (title: string, over: Record<string, unknown> = {}, tenantId = T_A, actor = owner) =>
  createPgCatalogApi({ pool: db.pool() }).registerBook(actor, { tenantId, source: "MANUAL", title, authors: ["저자"], listPriceKrw: "12000", reason: "시험", registeredAt: new Date().toISOString(), idempotencyKey: key(), ...over } as never);

describe("도서 조회 (읽기 API)", () => {
  it("활성 멤버만 자기 서점의 도서를 제목순으로 페이지 단위로 읽고, ISBN으로 거를 수 있으며 다른 서점 도서는 보이지 않는다", async () => {
    for (const title of ["다 책", "가 책", "나 책", "라 책"]) await addBook(title, title === "나 책" ? { isbn: "9788900002222" } : {});
    await addBook("다른 서점 책", {}, T_B, { userId: OWNER_B });

    expect(await codeOf(() => read().listBooks({ userId: STRANGER }, { tenantId: T_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => read().listBooks({ userId: EX_STAFF }, { tenantId: T_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => read().listBooks(staff, { tenantId: T_A, limit: 0 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().listBooks(staff, { tenantId: T_A, limit: 101 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().listBooks(staff, { tenantId: T_A, cursor: "not-a-cursor" }))).toBe("VALIDATION_ERROR");

    const first = await read().listBooks(staff, { tenantId: T_A, limit: 3 });
    expect(first.items.map((b) => b.title)).toEqual(["가 책", "나 책", "다 책"]);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items[1]).toMatchObject({ isbn: "9788900002222", listPriceKrw: "12000", source: "MANUAL", version: 1 });
    const second = await read().listBooks(staff, { tenantId: T_A, limit: 3, cursor: first.nextCursor });
    expect(second.items[0]!.title).toBe("라 책"); // 재고용 시드 도서(재고 책 N)가 뒤따른다
    expect(second.nextCursor).toBeTruthy();
    const all = await read().listBooks(staff, { tenantId: T_A, limit: 100 });
    expect(all.items.map((b) => b.title)).not.toContain("다른 서점 책");
    expect(all.nextCursor).toBeUndefined(); // 마지막 페이지에는 커서가 없다

    const byIsbn = await read().listBooks(staff, { tenantId: T_A, isbn: "978-89-0000-2222" });
    expect(byIsbn.items.map((b) => b.title)).toEqual(["나 책"]);
    expect(await codeOf(() => read().listBooks(staff, { tenantId: T_A, isbn: "abc" }))).toBe("VALIDATION_ERROR");
  });
});

describe("도서 상세·수정 이력·템플릿 조회 (읽기 API)", () => {
  it("도서 상세는 같은 서점만 보이고(없는 도서와 다른 서점 도서는 같은 404), 수정 이력은 오래된 순으로 읽힌다", async () => {
    const book = await addBook("상세 책");
    const other = await addBook("타 서점 책", {}, T_B, { userId: OWNER_B });
    expect((await read().getBook(staff, { tenantId: T_A, bookId: book.id })).title).toBe("상세 책");
    expect(await codeOf(() => read().getBook(staff, { tenantId: T_A, bookId: other.id }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().getBook(staff, { tenantId: T_A, bookId: "0a000000-0000-4000-8000-00000000ffff" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().getBook({ userId: STRANGER }, { tenantId: T_A, bookId: book.id }))).toBe("FORBIDDEN");

    const catalog = createPgCatalogApi({ pool: db.pool() });
    const changed = () => new Date().toISOString();
    await catalog.updateBook(owner, { tenantId: T_A, bookId: book.id, expectedVersion: 1, changes: { listPriceKrw: "13000" }, reason: "인상", changedAt: changed(), idempotencyKey: key() });
    await catalog.updateBook(staff, { tenantId: T_A, bookId: book.id, expectedVersion: 2, changes: { title: "상세 책(개정)" }, reason: "오타", changedAt: changed(), idempotencyKey: key() });
    const detail = await read().getBook(staff, { tenantId: T_A, bookId: book.id });
    expect(detail).toMatchObject({ title: "상세 책(개정)", version: 3, listPriceKrw: "13000" });
    const revisions = await read().listBookRevisions(staff, { tenantId: T_A, bookId: book.id });
    expect(revisions.map((r) => [r.versionBefore, r.versionAfter, r.reason])).toEqual([[1, 2, "인상"], [2, 3, "오타"]]);
    expect(revisions[0]!.before.listPriceKrw).toBe("12000");
    expect(await codeOf(() => read().listBookRevisions(staff, { tenantId: T_A, bookId: other.id }))).toBe("NOT_FOUND");
  });

  it("템플릿은 키별 최신 버전만 목록에 나오고, 키를 지정하면 모든 버전을 오래된 순으로 읽는다", async () => {
    const catalog = createPgCatalogApi({ pool: db.pool() });
    const publish = (templateKey: string, expectedVersion: number, body: string, tenantId = T_A, actor = owner) =>
      catalog.publishTemplateVersion(actor, { tenantId, key: templateKey, body, expectedVersion, publishedAt: new Date().toISOString(), idempotencyKey: key() });
    await publish("READ_A", 0, "{{bookTitle}} 첫 문구");
    await publish("READ_A", 1, "{{bookTitle}} 둘째 문구");
    await publish("READ_B", 0, "다른 문구");
    await publish("READ_A", 0, "타 서점", T_B, { userId: OWNER_B });

    const latest = await read().listMessageTemplates(staff, { tenantId: T_A });
    expect(latest.map((t) => [t.key, t.version, t.body])).toEqual([["READ_A", 2, "{{bookTitle}} 둘째 문구"], ["READ_B", 1, "다른 문구"]]);
    const history = await read().listMessageTemplates(staff, { tenantId: T_A, key: "READ_A" });
    expect(history.map((t) => t.version)).toEqual([1, 2]);
    expect(await read().listMessageTemplates(staff, { tenantId: T_A, key: "NONE" })).toEqual([]);
    expect(await codeOf(() => read().listMessageTemplates(staff, { tenantId: T_A, key: "bad key" }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().listMessageTemplates({ userId: EX_STAFF }, { tenantId: T_A }))).toBe("FORBIDDEN");
  });
});


describe("고객 안내 조회·미수령 경고 (읽기 API)", () => {
  const BOOK = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let bookSeq = 0;
  const at = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const notify = () => createPgNotificationApi({ pool: db.pool() });
  const rows = async (sql: string, params: unknown[] = []) => {
    const c = await db.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };

  /** 책 한 권을 확보(예약)한 확정 주문 */
  async function securedOrder(quantity: number) {
    const book = BOOK(++bookSeq);
    const orders = createPgOrderApi({ pool: db.pool() });
    const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: book, quantity, unitPriceKrw: "10000" }] });
    const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
    await rows(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, 'INITIAL', 'IN', 10, '초기 재고', 'seed', now())`, [T_A, book]);
    const reservation = await createPgStockApi({ pool: db.pool() }).reserveStock(owner, { tenantId: T_A, orderId: order.id, orderLineId: order.lines[0]!.lineId, quantity, reservedAt: at(), idempotencyKey: key() });
    return { orderId: order.id, reservation };
  }
  /** 안내를 끝낸(MANUAL_RECORDED) 대상을 만든다 */
  async function notified(orderId: string, resultDaysAgo: number) {
    const target = await notify().createNotificationTarget(staff, { tenantId: T_A, orderId, createdAt: at(), idempotencyKey: key() });
    const attempt = await notify().recordNotificationAttempt(staff, { tenantId: T_A, targetId: target.id, channel: "PHONE", messageSnapshot: "입고 안내", attemptedAt: at(), idempotencyKey: key() });
    await notify().recordNotificationResult(staff, { tenantId: T_A, attemptId: attempt.id, outcome: "MANUAL_RECORDED", note: "통화", resultAt: at(resultDaysAgo), idempotencyKey: key() });
    return target;
  }

  it("주문의 안내 대상은 시도·결과에서 파생한 상태와 함께 읽히고, 다른 서점의 주문은 404이다", async () => {
    const o = await securedOrder(2);
    expect(await read().listNotificationTargets(staff, { tenantId: T_A, orderId: o.orderId })).toEqual([]);
    const target = await notify().createNotificationTarget(staff, { tenantId: T_A, orderId: o.orderId, createdAt: at(), idempotencyKey: key() });
    let items = await read().listNotificationTargets(staff, { tenantId: T_A, orderId: o.orderId });
    expect(items.map((i) => [i.id, i.status, i.attemptCount])).toEqual([[target.id, "PENDING", 0]]);

    const attempt = await notify().recordNotificationAttempt(staff, { tenantId: T_A, targetId: target.id, channel: "SMS", messageSnapshot: "안내", attemptedAt: at(), idempotencyKey: key() });
    items = await read().listNotificationTargets(staff, { tenantId: T_A, orderId: o.orderId });
    expect(items[0]).toMatchObject({ status: "ATTEMPTED", attemptCount: 1, lastAttempt: { id: attempt.id, channel: "SMS" } });
    await notify().recordNotificationResult(staff, { tenantId: T_A, attemptId: attempt.id, outcome: "FAILED", note: "부재중", resultAt: at(), idempotencyKey: key() });
    items = await read().listNotificationTargets(staff, { tenantId: T_A, orderId: o.orderId });
    expect(items[0]).toMatchObject({ status: "FAILED", lastResult: { outcome: "FAILED", note: "부재중" } });

    expect(await codeOf(() => read().listNotificationTargets(staff, { tenantId: T_A, orderId: "0a000000-0000-4000-8000-00000000ffff" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().listNotificationTargets({ userId: STRANGER }, { tenantId: T_A, orderId: o.orderId }))).toBe("FORBIDDEN");
  });

  it("안내를 마친 지 기준일이 지나도 확보분이 남은 주문만 경고에 나오고, 확보분이 풀리거나 기준일 전이면 나오지 않는다", async () => {
    const old = await securedOrder(2);
    await notified(old.orderId, 10);
    const fresh = await securedOrder(1);
    await notified(fresh.orderId, 1);
    const released = await securedOrder(1);
    await notified(released.orderId, 10);
    await createPgStockApi({ pool: db.pool() }).releaseStockReservation(owner, { tenantId: T_A, reservationId: released.reservation.id, quantity: 1, reason: "취소", releasedAt: at(), idempotencyKey: key() } as never);

    const warnings = await read().longUnreceivedWarnings(staff, { tenantId: T_A });
    expect(warnings.map((w) => w.orderId)).toContain(old.orderId);
    expect(warnings.map((w) => w.orderId)).not.toContain(fresh.orderId);
    expect(warnings.map((w) => w.orderId)).not.toContain(released.orderId);
    expect(warnings.find((w) => w.orderId === old.orderId)).toMatchObject({ securedQuantity: 2, daysElapsed: 10 });
    expect((await read().longUnreceivedWarnings(staff, { tenantId: T_A, thresholdDays: 30 })).map((w) => w.orderId)).not.toContain(old.orderId);
    expect((await read().longUnreceivedWarnings(staff, { tenantId: T_A, thresholdDays: 1 })).map((w) => w.orderId)).toContain(fresh.orderId);
    expect(await codeOf(() => read().longUnreceivedWarnings(staff, { tenantId: T_A, thresholdDays: 0 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().longUnreceivedWarnings({ userId: EX_STAFF }, { tenantId: T_A }))).toBe("FORBIDDEN");
  });
});

describe("공급처 조회 (읽기 API)", () => {
  it("활성 멤버는 자기 서점 공급처를 코드순으로 읽고(비활성 포함), 다른 서점 공급처는 보이지 않는다", async () => {
    const c = await db.connect();
    await c.query(
      `insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel) values ($1, 'zeta', true, '제타 유통', 'EMAIL'), ($1, 'alpha', false, '알파 도매', 'WEB'), ($2, 'beta', true, '다른 서점 공급처', 'PHONE')`,
      [T_A, T_B],
    );
    await c.end();

    const list = await read().listSuppliers(staff, { tenantId: T_A });
    expect(list.map((s) => s.code)).toEqual(["alpha", "zeta"]);
    expect(list[0]).toMatchObject({ tenantId: T_A, active: false, name: "알파 도매", orderChannel: "WEB", version: 1 });
    expect(await codeOf(() => read().listSuppliers({ userId: STRANGER }, { tenantId: T_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => read().listSuppliers({ userId: EX_STAFF }, { tenantId: T_A }))).toBe("FORBIDDEN");
  });
});

describe("공급처 상세 (읽기 API)", () => {
  it("공급처 상세는 같은 서점만 보이고 없는 코드·다른 서점 코드는 같은 404이다", async () => {
    expect(await read().getSupplier(staff, { tenantId: T_A, code: "zeta" })).toMatchObject({ code: "zeta", active: true, name: "제타 유통", orderChannel: "EMAIL" });
    expect(await codeOf(() => read().getSupplier(staff, { tenantId: T_A, code: "beta" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().getSupplier(staff, { tenantId: T_A, code: "nope" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().getSupplier({ userId: STRANGER }, { tenantId: T_A, code: "zeta" }))).toBe("FORBIDDEN");
  });
});

describe("발주 조회 (읽기 API)", () => {
  const PO = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const sql = async (text: string, params: unknown[] = []) => {
    const c = await db.connect();
    try {
      return (await c.query(text, params)).rows;
    } finally {
      await c.end();
    }
  };

  it("발주 목록은 최신순·상태/공급처 필터·페이지로 읽고, 상세는 품목과 주문 연결을 담으며, 다른 서점·없는 발주는 404이다", async () => {
    const orders = createPgOrderApi({ pool: db.pool() });
    const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: "b0000000-0000-4000-8000-000000000001", quantity: 2, unitPriceKrw: "10000" }] });
    const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
    const lineId = order.lines[0]!.lineId;
    for (let n = 1; n <= 3; n++) {
      await sql(`insert into public.ordering_purchase_orders (id, tenant_id, supplier_code, status, created_at) values ($1, $2, $3, $4, now() - make_interval(mins => $5))`, [PO(n), T_A, n === 3 ? "zeta" : "alpha", n === 2 ? "SENT" : "DRAFT", 10 - n]);
    }
    await sql(`insert into public.ordering_purchase_orders (id, tenant_id, supplier_code, status) values ($1, $2, 'beta', 'DRAFT')`, [PO(9), T_B]);
    const poLine = (await sql(`insert into public.ordering_po_lines (tenant_id, purchase_order_id, book_key, quantity) values ($1, $2, 'b0000000-0000-4000-8000-000000000001', 2) returning id`, [T_A, PO(1)]))[0].id as string;
    const alloc = (await sql(`insert into public.ordering_sourcing_allocations (tenant_id, order_id, order_line_id, supplier_code, quantity) values ($1, $2, $3, 'alpha', 2) returning id`, [T_A, order.id, lineId]))[0].id as string;
    await sql(`insert into public.ordering_po_links (tenant_id, po_line_id, allocation_id, order_id, order_line_id, quantity) values ($1, $2, $3, $4, $5, 2)`, [T_A, poLine, alloc, order.id, lineId]);

    const all = await read().listPurchaseOrders(staff, { tenantId: T_A });
    expect(all.items.map((p) => p.id)).toEqual([PO(3), PO(2), PO(1)]);
    expect((await read().listPurchaseOrders(staff, { tenantId: T_A, status: "SENT" })).items.map((p) => p.id)).toEqual([PO(2)]);
    expect((await read().listPurchaseOrders(staff, { tenantId: T_A, supplierCode: "alpha" })).items.map((p) => p.id)).toEqual([PO(2), PO(1)]);
    const first = await read().listPurchaseOrders(staff, { tenantId: T_A, limit: 2 });
    expect(first.items.map((p) => p.id)).toEqual([PO(3), PO(2)]);
    expect((await read().listPurchaseOrders(staff, { tenantId: T_A, limit: 2, cursor: first.nextCursor })).items.map((p) => p.id)).toEqual([PO(1)]);

    const detail = await read().getPurchaseOrder(staff, { tenantId: T_A, purchaseOrderId: PO(1) });
    expect(detail).toMatchObject({ id: PO(1), supplierCode: "alpha", status: "DRAFT", version: 1 });
    expect(detail.lines[0]).toMatchObject({ poLineId: poLine, quantity: 2, links: [{ allocationId: alloc, orderId: order.id, orderLineId: lineId, quantity: 2 }] });

    expect(await codeOf(() => read().getPurchaseOrder(staff, { tenantId: T_A, purchaseOrderId: PO(9) }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().getPurchaseOrder(staff, { tenantId: T_A, purchaseOrderId: "not-a-uuid" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().listPurchaseOrders(staff, { tenantId: T_A, status: "BOGUS" }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().listPurchaseOrders({ userId: STRANGER }, { tenantId: T_A }))).toBe("FORBIDDEN");
  });
});

describe("재고 현황 조회 (읽기 API)", () => {
  const B9 = "b0000000-0000-4000-8000-000000000009";
  const B10 = "b0000000-0000-4000-8000-000000000010";
  const sql = async (text: string, params: unknown[] = []) => {
    const c = await db.connect();
    try {
      return (await c.query(text, params)).rows;
    } finally {
      await c.end();
    }
  };

  it("도서별 보유·예약·가용을 원장에서 파생해 읽고(해제 반영), 키 순 페이지·없는 도서 404·다른 서점 비노출을 지킨다", async () => {
    const orders = createPgOrderApi({ pool: db.pool() });
    const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: B9, quantity: 3, unitPriceKrw: "10000" }] });
    const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
    const move = (tenant: string, book: string, direction: string, qty: number, kind = "INITIAL") =>
      sql(`insert into public.ordering_stock_movements (tenant_id, book_key, kind, direction, quantity, reason, acted_by, acted_at) values ($1, $2, $5, $3, $4, '시험', 'seed', now())`, [tenant, book, direction, qty, kind]);
    await move(T_A, B9, "IN", 10);
    await move(T_A, B10, "IN", 4);
    await move(T_A, B10, "OUT", 1, "ADJUST");
    await move(T_B, B10, "IN", 99);
    const stock = createPgStockApi({ pool: db.pool() });
    const reservation = await stock.reserveStock(owner, { tenantId: T_A, orderId: order.id, orderLineId: order.lines[0]!.lineId, quantity: 3, reservedAt: new Date().toISOString(), idempotencyKey: key() });
    await stock.releaseStockReservation(owner, { tenantId: T_A, reservationId: reservation.id, quantity: 1, reason: "일부 해제", releasedAt: new Date().toISOString(), idempotencyKey: key() } as never);

    const all = await read().listStockLevels(staff, { tenantId: T_A });
    expect(all.items.find((s) => s.bookId === B9)).toEqual({ bookId: B9, onHand: 10, reserved: 2, available: 8 });
    expect(all.items.find((s) => s.bookId === B10)).toEqual({ bookId: B10, onHand: 3, reserved: 0, available: 3 });
    expect(all.items.map((s) => s.bookId)).toEqual([...all.items.map((s) => s.bookId)].sort());
    const first = await read().listStockLevels(staff, { tenantId: T_A, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect((await read().listStockLevels(staff, { tenantId: T_A, limit: 1, cursor: first.nextCursor })).items[0]!.bookId).not.toBe(first.items[0]!.bookId);

    expect(await read().getStockLevel(staff, { tenantId: T_A, bookId: B9 })).toEqual({ bookId: B9, onHand: 10, reserved: 2, available: 8 });
    expect(await codeOf(() => read().getStockLevel(staff, { tenantId: T_A, bookId: "b0000000-0000-4000-8000-0000000000ff" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().listStockLevels(staff, { tenantId: T_A, limit: 0 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().listStockLevels({ userId: STRANGER }, { tenantId: T_A }))).toBe("FORBIDDEN");
  });
});

describe("결제 현황 조회 (읽기 API)", () => {
  it("주문의 결제 거래와 요약(확인·대기·무효 반영)을 원장에서 파생해 읽고, 다른 서점·없는 주문은 404, 비멤버는 403이다", async () => {
    const orders = createPgOrderApi({ pool: db.pool() });
    const draft = await orders.createOrder(owner, { tenantId: T_A, idempotencyKey: key(), lines: [{ bookId: "b0000000-0000-4000-8000-000000000008", quantity: 1, unitPriceKrw: "10000" }] });
    const order = await orders.confirmOrder(owner, { tenantId: T_A, orderId: draft.id, expectedVersion: 1, idempotencyKey: key() });
    const pay = createPgPaymentApi({ pool: db.pool() });
    const paidAt = "2026-03-04T06:00:00.000Z";
    const record = (amountKrw: string, externalReference: string) => pay.recordPayment(staff, { tenantId: T_A, orderId: order.id, method: "BANK_TRANSFER", amountKrw, externalReference, paidAt, idempotencyKey: key() });
    const p1 = await record("6000", "R-1");
    await pay.confirmPayment(staff, { tenantId: T_A, paymentId: p1.id, evidence: "입금 확인", confirmedAt: paidAt, idempotencyKey: key() });
    await record("3000", "R-2"); // 확인 전
    const p3 = await record("1000", "R-3");
    await pay.voidPayment(staff, { tenantId: T_A, paymentId: p3.id, reason: "오입력", voidedAt: paidAt, idempotencyKey: key() } as never);

    const view = await read().getOrderPayments(staff, { tenantId: T_A, orderId: order.id });
    expect(view.summary).toMatchObject({ totalKrw: "10000", confirmedKrw: "6000", pendingKrw: "3000", balanceKrw: "4000", refundRequiredKrw: "0" });
    expect(view.payments.map((p) => [p.externalReference, p.status])).toEqual([["R-1", "CONFIRMED"], ["R-2", "PENDING"], ["R-3", "VOIDED"]]);
    expect(view.confirmations).toHaveLength(1);
    expect(view.voids).toHaveLength(1);

    expect(await codeOf(() => read().getOrderPayments(staff, { tenantId: T_A, orderId: "0a000000-0000-4000-8000-00000000ffff" }))).toBe("NOT_FOUND");
    expect(await codeOf(() => read().getOrderPayments({ userId: OWNER_B }, { tenantId: T_A, orderId: order.id }))).toBe("FORBIDDEN");
    expect(await codeOf(() => read().getOrderPayments({ userId: STRANGER }, { tenantId: T_A, orderId: order.id }))).toBe("FORBIDDEN");
  });
});

describe("감사 로그 조회 (읽기 API, Owner 전용)", () => {
  it("Owner만 자기 서점의 감사 기록을 최신순·페이지로 읽고(행위자 필터), 직원·비멤버·타 서점은 읽지 못한다", async () => {
    const c = await db.connect();
    for (let n = 1; n <= 5; n++) {
      await c.query(`insert into public.ordering_audit_log (tenant_id, actor_id, operation, command_key, request_hash, targets) values ($1, $2, 'POST /v1/tenants/{tenantId}/orders', $3, $4, '{"orderId":"o"}')`, [T_A, n % 2 ? OWNER_A : STAFF_A, `audit-${n}`, "c".repeat(64)]);
    }
    await c.query(`insert into public.ordering_audit_log (tenant_id, actor_id, operation, command_key, request_hash) values ($1, $2, 'POST /v1/tenants/{tenantId}/orders', 'other-tenant', $3)`, [T_B, OWNER_B, "c".repeat(64)]);
    await c.end();

    const all = await read().listAuditLog(owner, { tenantId: T_A });
    expect(all.items.map((r) => r.commandKey).slice(0, 5)).toEqual(["audit-5", "audit-4", "audit-3", "audit-2", "audit-1"]);
    expect(all.items.some((r) => r.commandKey === "other-tenant")).toBe(false);
    expect(all.items[0]).toMatchObject({ tenantId: T_A, actorId: OWNER_A, operation: "POST /v1/tenants/{tenantId}/orders", requestHash: "c".repeat(64), targets: { orderId: "o" } });

    const first = await read().listAuditLog(owner, { tenantId: T_A, limit: 2 });
    expect(first.items.map((r) => r.commandKey)).toEqual(["audit-5", "audit-4"]);
    expect((await read().listAuditLog(owner, { tenantId: T_A, limit: 2, cursor: first.nextCursor })).items.map((r) => r.commandKey)).toEqual(["audit-3", "audit-2"]);
    expect((await read().listAuditLog(owner, { tenantId: T_A, actorId: STAFF_A })).items.map((r) => r.commandKey)).toEqual(["audit-4", "audit-2"]);

    expect(await codeOf(() => read().listAuditLog(staff, { tenantId: T_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => read().listAuditLog({ userId: STRANGER }, { tenantId: T_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => read().listAuditLog({ userId: OWNER_B }, { tenantId: T_A }))).toBe("FORBIDDEN");
    expect(await codeOf(() => read().listAuditLog(owner, { tenantId: T_A, limit: 0 }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().listAuditLog(owner, { tenantId: T_A, actorId: "nope" }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => read().listAuditLog(owner, { tenantId: T_A, cursor: "zzz" }))).toBe("VALIDATION_ERROR");
  });
});
