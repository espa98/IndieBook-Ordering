import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 저장 도중 실패 주입(T4): 쓰기 명령은 한 트랜잭션으로 저장·롤백해야 한다. 지금까지는 거부된 시도가 아무것도 남기지 않음만 확인했고,
 * **명령의 모든 쓰기가 끝난 뒤** 실패하는 경우는 확인하지 않았다. 감사 행은 `inTransaction`에서 명령이 끝난 뒤 가장 마지막에 쓰이므로(`pgSupport.ts`),
 * 감사 삽입에 실패를 주입하면 명령의 모든 쓰기 뒤에 실패한다. 이때 DB 전체(모든 `ordering_*` 테이블의 내용)가 실패 전과 같아야 한다.
 */
const SECRET = "atomic-rollback-secret-0123456789abcdef0123";
const T = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";
const PAST = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

/** 모든 ordering_* 테이블의 내용 해시: 개수만 세면 UPDATE(버전 증가·상태 변경)를 놓친다 */
async function snapshot(): Promise<Record<string, string>> {
  const c = await db.connect();
  try {
    const tables = (await c.query("select tablename from pg_tables where schemaname = 'public' and tablename like 'ordering\_%' order by tablename")).rows.map((r) => r.tablename as string);
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await c.query(`select count(*)::int as n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from public.${t} x`);
      out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  } finally {
    await c.end();
  }
}
const diff = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((t) => a[t] !== b[t]);

/** 감사 행 삽입(명령의 모든 쓰기 뒤, 커밋 직전)에서 실패하게 하는 트리거를 켜고 끈다 */
async function injectFault(on: boolean) {
  const c = await db.connect();
  try {
    if (on) {
      await c.query(`create or replace function public.__inject_fault() returns trigger language plpgsql as $$ begin raise exception 'injected failure' using errcode = 'XX000'; end $$`);
      await c.query(`create trigger __inject_fault before insert on public.ordering_audit_log for each row execute function public.__inject_fault()`);
    } else {
      await c.query(`drop trigger if exists __inject_fault on public.ordering_audit_log`);
    }
  } finally {
    await c.end();
  }
}

let seq = 0;
async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "POST") headers["idempotency-key"] = `atomic-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

/**
 * 쓰기 한 단계를 두 번 실행한다. 먼저 감사 삽입이 실패하게 해서 500이고 DB가 그대로인지 확인하고, 그다음 실제로 실행해 시나리오를 이어 간다.
 * 이 두 번째 실행이 성공하므로 첫 실패가 멱등 기록·감사·버전 같은 흔적을 남겼다면(재시도가 409·중복으로 어긋남) 그것도 드러난다.
 */
const faulted: string[] = [];
/** 실패 주입을 거친 서버 경로 템플릿(서점 범위 POST) */
const coveredTemplates = new Set<string>();
const templateOf = (path: string) => {
  const route = app.routes.find((r) => r.scope === "tenant" && r.method === "POST" && new RegExp(`^${r.template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path));
  return route?.template;
};
async function write(label: string, path: string, body: unknown, status: number) {
  const before = await snapshot();
  await injectFault(true);
  const failed = await call("POST", path, body);
  await injectFault(false);
  expect(failed.status, `${label}: 실패 주입 시 500이어야 한다 ${JSON.stringify(failed.body)}`).toBe(500);
  expect(diff(before, await snapshot()), `${label}: 실패 뒤 변경된 테이블`).toEqual([]);
  faulted.push(label);
  const template = templateOf(path);
  if (template) coveredTemplates.add(template);
  const real = await call("POST", path, body);
  expect(real.status, `${label}: 실제 실행 ${JSON.stringify(real.body)}`).toBe(status);
  return real.body.data;
}

describe("저장 도중 실패 주입: 모든 쓰기 뒤 실패해도 아무것도 남지 않는다", () => {
  it("도서·공급처·템플릿·주문·결제·조달 쓰기 명령", async () => {
    const book = await write("도서 등록", "/books", { source: "MANUAL", title: "원자성 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: PAST }, 201);
    await write("도서 수정", `/books/${book.id}/updates`, { expectedVersion: 1, changes: { title: "원자성 책 2판" }, reason: "정정", changedAt: PAST }, 200);
    await write("공급처 등록", "/suppliers", { code: "atomic-sup", name: "원자 도매", orderChannel: "EMAIL", registeredAt: PAST }, 201);
    await write("공급처 수정", "/suppliers/atomic-sup/updates", { expectedVersion: 1, changes: { name: "원자 유통" }, reason: "상호 변경", changedAt: PAST }, 200);
    await write("공급처 활성 전환", "/suppliers/atomic-sup/activation", { active: false, reason: "일시 중단", changedAt: PAST }, 200);
    await write("공급처 활성 복구", "/suppliers/atomic-sup/activation", { active: true, reason: "재개", changedAt: PAST }, 200);
    await write("문구 템플릿 게시", "/message-templates", { key: "ATOMIC_READY", body: "{{storeName}}입니다", expectedVersion: 0, publishedAt: PAST }, 201);

    const order = await write("주문 생성", "/orders", { lines: [{ bookId: book.id, quantity: 2, unitPriceKrw: "10000" }] }, 201);
    const confirmed = await write("주문 확정", `/orders/${order.id}/confirm`, { expectedVersion: 1 }, 200);
    const lineId = confirmed.lines[0].lineId as string;
    const payment = await write("결제 입력", `/orders/${order.id}/payments`, { method: "BANK_TRANSFER", amountKrw: "20000", externalReference: "ATOMIC-1", paidAt: PAST }, 201);
    await write("결제 확인", `/payments/${payment.id}/confirmation`, { evidence: "입금 확인", confirmedAt: PAST }, 201);
    const allocation = await write("조달 배정", `/orders/${order.id}/lines/${lineId}/sourcing-allocations`, { supplierCode: "atomic-sup", quantity: 2 }, 201);
    const po = await write("발주 생성", "/purchase-orders", { supplierCode: "atomic-sup", allocationIds: [allocation.id] }, 201);
    await write("발주 준비", `/purchase-orders/${po.id}/ready`, { expectedVersion: 1 }, 200);
    await write("발주 전달", `/purchase-orders/${po.id}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: PAST }, 200);
    expect(faulted).toEqual(expect.arrayContaining(["도서 등록", "도서 수정", "공급처 등록", "공급처 수정", "공급처 활성 전환", "문구 템플릿 게시", "주문 생성", "주문 확정", "결제 입력", "결제 확인", "조달 배정", "발주 생성", "발주 준비", "발주 전달"]));
  });

  it("재고·예약·수령·결제 정정 쓰기 명령", async () => {
    const before = faulted.length;
    const book = await write("도서 등록(재고)", "/books", { source: "MANUAL", title: "재고 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: PAST }, 201);
    await write("초기 재고", `/books/${book.id}/initial-stock`, { quantity: 5, actedAt: PAST }, 201);
    await write("재고 조정", `/books/${book.id}/stock-adjustments`, { direction: "IN", quantity: 2, reason: "실사 반영", actedAt: PAST }, 201);
    const order = await write("주문 생성(재고)", "/orders", { lines: [{ bookId: book.id, quantity: 3, unitPriceKrw: "10000" }] }, 201);
    const confirmed = await write("주문 확정(재고)", `/orders/${order.id}/confirm`, { expectedVersion: 1 }, 200);
    const lineId = confirmed.lines[0].lineId as string;
    const reservation = await write("재고 예약", `/orders/${order.id}/lines/${lineId}/stock-reservations`, { quantity: 3, reservedAt: PAST }, 201);
    await write("예약 해제", `/stock-reservations/${reservation.id}/releases`, { quantity: 1, reason: "수량 조정", releasedAt: PAST }, 201);
    const paid = await write("결제 입력(수령)", `/orders/${order.id}/payments`, { method: "BANK_TRANSFER", amountKrw: "20000", externalReference: "ATOMIC-2", paidAt: PAST }, 201);
    await write("결제 확인(수령)", `/payments/${paid.id}/confirmation`, { evidence: "입금 확인", confirmedAt: PAST }, 201);
    const extra = await write("결제 입력(무효용)", `/orders/${order.id}/payments`, { method: "CARD", amountKrw: "5000", externalReference: "ATOMIC-3", paidAt: PAST }, 201);
    await write("결제 무효", `/payments/${extra.id}/void`, { reason: "중복 입력", voidedAt: PAST }, 201);
    await write("결제 정정", `/payments/${paid.id}/corrections`, { reducedKrw: "1000", reason: "금액 오기록", evidence: "재확인", correctedAt: PAST }, 201);
    const fulfillment = await write("수령 등록", `/orders/${order.id}/fulfillments`, { orderLineId: lineId, sources: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 2 }], receivedAt: PAST }, 201);
    await write("수령 정정", `/orders/${order.id}/fulfillments/${fulfillment.id}/corrections`, { quantity: 1, restorations: [{ kind: "STOCK_RESERVATION", sourceId: reservation.id, quantity: 1 }], reason: "반품 입고", evidence: "반입 확인서", physicalReturnConfirmed: true, correctedAt: PAST }, 201);
    expect(faulted.slice(before)).toEqual(expect.arrayContaining(["초기 재고", "재고 조정", "재고 예약", "예약 해제", "결제 무효", "결제 정정", "수령 등록", "수령 정정"]));
  });

  it("입고·불량·초과·배분·배분 취소·재배분·해제·입고 정정 쓰기 명령", async () => {
    const before = faulted.length;
    const book = await write("도서 등록(입고)", "/books", { source: "MANUAL", title: "입고 책", listPriceKrw: "9000", reason: "수기 등록", registeredAt: PAST }, 201);
    await write("공급처 등록(입고)", "/suppliers", { code: "atomic-recv", name: "입고 도매", orderChannel: "EMAIL", registeredAt: PAST }, 201);
    const lineOf = async (label: string, quantity: number) => {
      const order = await write(`주문 생성(${label})`, "/orders", { lines: [{ bookId: book.id, quantity, unitPriceKrw: "9000" }] }, 201);
      const confirmed = await write(`주문 확정(${label})`, `/orders/${order.id}/confirm`, { expectedVersion: 1 }, 200);
      return { orderId: order.id as string, lineId: confirmed.lines[0].lineId as string };
    };
    const first = await lineOf("입고1", 3);
    const second = await lineOf("입고2", 2);
    const a1 = await write("조달 배정(입고1)", `/orders/${first.orderId}/lines/${first.lineId}/sourcing-allocations`, { supplierCode: "atomic-recv", quantity: 3 }, 201);
    const a2 = await write("조달 배정(입고2)", `/orders/${second.orderId}/lines/${second.lineId}/sourcing-allocations`, { supplierCode: "atomic-recv", quantity: 2 }, 201);
    const po = await write("발주 생성(입고)", "/purchase-orders", { supplierCode: "atomic-recv", allocationIds: [a1.id, a2.id] }, 201);
    await write("발주 준비(입고)", `/purchase-orders/${po.id}/ready`, { expectedVersion: 1 }, 200);
    await write("발주 전달(입고)", `/purchase-orders/${po.id}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: PAST }, 200);
    const poLineId = (await call("GET", `/purchase-orders/${po.id}`)).body.data.lines[0].poLineId as string;

    const receipt = await write("입고", `/purchase-orders/${po.id}/receipts`, { poLineId, normalQuantity: 6, damagedQuantity: 1, misdeliveredQuantity: 0, receivedAt: PAST }, 201);
    await write("입고 불량 처리", `/receipts/${receipt.id}/defect-resolutions`, { kind: "DAMAGED", quantity: 1, outcome: "RETURNED_TO_SUPPLIER", evidence: "반품 접수증", resolvedAt: PAST }, 201);
    await write("초과 입고 결정", `/receipts/${receipt.id}/excess-decisions`, { decision: "APPROVED", quantity: 1, reason: "재고 편입 승인", decidedAt: PAST }, 201);
    const allocation = await write("입고 배분", `/receipts/${receipt.id}/allocations`, { orderId: first.orderId, orderLineId: first.lineId, quantity: 3, allocatedAt: PAST }, 201);
    await write("배분 취소", `/allocations/${allocation.id}/cancellations`, { quantity: 1, reason: "고객 변심", cancelledAt: PAST }, 201);
    await write("재배분", `/allocations/${allocation.id}/reallocations`, { toOrderId: second.orderId, toOrderLineId: second.lineId, quantity: 1, reason: "다른 주문에 배정", actedAt: PAST }, 201);
    await write("배분 해제", `/allocations/${allocation.id}/releases`, { quantity: 1, reason: "배분 해제", releasedAt: PAST }, 201);
    await write("입고 정정", `/receipts/${receipt.id}/corrections`, { quantity: 1, reason: "수량 오기록", correctedAt: PAST }, 201);
    expect(faulted.slice(before)).toEqual(expect.arrayContaining(["입고", "입고 불량 처리", "초과 입고 결정", "입고 배분", "배분 취소", "재배분", "배분 해제", "입고 정정"]));
  });

  it("주문 취소·종결·취소 물량 처분·반품 쓰기 명령", async () => {
    const before = faulted.length;
    const book = await write("도서 등록(취소)", "/books", { source: "MANUAL", title: "취소 책", listPriceKrw: "9000", reason: "수기 등록", registeredAt: PAST }, 201);
    await write("초기 재고(취소)", `/books/${book.id}/initial-stock`, { quantity: 1, actedAt: PAST }, 201);
    await write("공급처 등록(취소)", "/suppliers", { code: "atomic-cancel", name: "취소 도매", orderChannel: "EMAIL", registeredAt: PAST }, 201);
    const lineOf = async (label: string, quantity: number) => {
      const order = await write(`주문 생성(${label})`, "/orders", { lines: [{ bookId: book.id, quantity, unitPriceKrw: "9000" }] }, 201);
      const confirmed = await write(`주문 확정(${label})`, `/orders/${order.id}/confirm`, { expectedVersion: 1 }, 200);
      return { orderId: order.id as string, lineId: confirmed.lines[0].lineId as string };
    };

    // 주문 취소 → 결정 → 적용 → 종결 요청
    const plain = await lineOf("취소1", 2);
    const request = await write("주문 취소 요청", `/orders/${plain.orderId}/cancellation-requests`, { orderLineId: plain.lineId, quantity: 2, reason: "고객 요청", expectedVersion: 2, requestedAt: PAST }, 201);
    await write("주문 취소 결정", `/order-cancellation-requests/${request.id}/decision`, { decision: "APPROVED", decidedAt: PAST }, 200);
    await write("주문 취소 적용", `/order-cancellation-requests/${request.id}/application`, { appliedAt: PAST }, 201);
    const version = (await call("GET", `/orders/${plain.orderId}`)).body.data.version as number;
    await write("종결 요청", `/orders/${plain.orderId}/closure-requests`, { expectedVersion: version, requestedAt: PAST }, 201);

    // 입고·배분 후 배분을 취소해 처분 대기 물량을 만들고, 재고 편입과 반품 체인을 거친다
    const target = await lineOf("취소2", 5);
    const sourcing = await write("조달 배정(취소)", `/orders/${target.orderId}/lines/${target.lineId}/sourcing-allocations`, { supplierCode: "atomic-cancel", quantity: 5 }, 201);
    const po = await write("발주 생성(취소)", "/purchase-orders", { supplierCode: "atomic-cancel", allocationIds: [sourcing.id] }, 201);
    await write("발주 준비(취소)", `/purchase-orders/${po.id}/ready`, { expectedVersion: 1 }, 200);
    await write("발주 전달(취소)", `/purchase-orders/${po.id}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: PAST }, 200);
    const poLineId = (await call("GET", `/purchase-orders/${po.id}`)).body.data.lines[0].poLineId as string;
    const receipt = await write("입고(취소)", `/purchase-orders/${po.id}/receipts`, { poLineId, normalQuantity: 5, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: PAST }, 201);
    const allocation = await write("입고 배분(취소)", `/receipts/${receipt.id}/allocations`, { orderId: target.orderId, orderLineId: target.lineId, quantity: 5, allocatedAt: PAST }, 201);
    const cancelOne = await write("배분 취소 1권", `/allocations/${allocation.id}/cancellations`, { quantity: 1, reason: "취소 1", cancelledAt: PAST }, 201);
    const cancelRest = await write("배분 취소 4권", `/allocations/${allocation.id}/cancellations`, { quantity: 4, reason: "취소 4", cancelledAt: PAST }, 201);
    await write("재고 편입", `/allocation-cancellations/${cancelOne.id}/stock-intakes`, { quantity: 1, actedAt: PAST }, 201);
    const returnRequest = await write("반품 요청", `/allocation-cancellations/${cancelRest.id}/return-requests`, { quantity: 4, requestedAt: PAST }, 201);
    await write("반품 회신", `/return-requests/${returnRequest.id}/replies`, { acceptedQuantity: 3, rejectedQuantity: 1, evidence: "공급처 회신", repliedAt: PAST }, 201);
    await write("반품 출고", `/return-requests/${returnRequest.id}/dispatches`, { quantity: 3, dispatchedAt: PAST, referenceNumber: "TRK-1" }, 201);
    const exception = await write("반품 예외", `/return-requests/${returnRequest.id}/exceptions`, { quantity: 1, kind: "LOST", evidence: "운송장 분실", reportedAt: PAST }, 201);
    await write("반품 예외 해소", `/return-exceptions/${exception.id}/resolutions`, { outcome: "RETURNED", quantity: 1, evidence: "공급처 확인", resolvedAt: PAST }, 201);
    await write("반품 재협의", `/return-requests/${returnRequest.id}/renegotiations`, { quantity: 1, retryReason: "재협의", requestedAt: PAST }, 201);
    await write("반품 완료", `/return-requests/${returnRequest.id}/completions`, { quantity: 2, evidence: "반품 완료 확인", confirmedAt: PAST }, 201);
    expect(faulted.slice(before)).toEqual(expect.arrayContaining(["주문 취소 요청", "주문 취소 결정", "주문 취소 적용", "종결 요청", "배분 취소 1권", "재고 편입", "반품 요청", "반품 회신", "반품 출고", "반품 예외", "반품 예외 해소", "반품 재협의", "반품 완료"]));
  });

  it("환급·고객 안내·직원 관리 쓰기 명령", async () => {
    const before = faulted.length;
    const book = await write("도서 등록(환급)", "/books", { source: "MANUAL", title: "환급 책", listPriceKrw: "15000", reason: "수기 등록", registeredAt: PAST }, 201);
    await write("초기 재고(환급)", `/books/${book.id}/initial-stock`, { quantity: 2, actedAt: PAST }, 201);

    // 과수납 주문 → 환급 업무·요청·시도·해소·결정
    const order = await write("주문 생성(환급)", "/orders", { lines: [{ bookId: book.id, quantity: 1, unitPriceKrw: "15000" }] }, 201);
    await write("주문 확정(환급)", `/orders/${order.id}/confirm`, { expectedVersion: 1 }, 200);
    const paid = await write("결제 입력(환급)", `/orders/${order.id}/payments`, { method: "BANK_TRANSFER", amountKrw: "20000", externalReference: "ATOMIC-4", paidAt: PAST }, 201);
    await write("결제 확인(환급)", `/payments/${paid.id}/confirmation`, { evidence: "입금 확인", confirmedAt: PAST }, 201);
    const task = await write("환급 업무", `/orders/${order.id}/refund-tasks`, { openedAt: PAST }, 201);
    const refundRequest = await write("환급 요청", `/refund-tasks/${task.id}/refund-requests`, { paymentId: paid.id, amountKrw: "3000", evidence: "고객 환급 요청", requestedAt: PAST }, 201);
    const attempt = await write("환급 시도 보고", `/refund-tasks/${task.id}/refund-attempts`, { paymentId: paid.id, amountKrw: "2000", result: "UNKNOWN", reason: "이체 결과 불명", reportedAt: PAST }, 201);
    await write("환급 시도 해소", `/refund-attempts/${attempt.id}/resolution`, { outcome: "CONFIRMED", evidence: "이체 내역 확인", resolvedAt: PAST }, 201);
    await write("환급 요청 결정", `/refund-requests/${refundRequest.id}/decision`, { decision: "APPROVED", decidedAt: PAST }, 200);

    // 확보 물량이 있는 주문 → 안내 대상·복사·시도·결과·재안내
    const reserved = await write("주문 생성(안내)", "/orders", { lines: [{ bookId: book.id, quantity: 1, unitPriceKrw: "15000" }] }, 201);
    const reservedConfirmed = await write("주문 확정(안내)", `/orders/${reserved.id}/confirm`, { expectedVersion: 1 }, 200);
    await write("재고 예약(안내)", `/orders/${reserved.id}/lines/${reservedConfirmed.lines[0].lineId}/stock-reservations`, { quantity: 1, reservedAt: PAST }, 201);
    const target = await write("안내 대상", `/orders/${reserved.id}/notification-targets`, { mode: "FULL", createdAt: PAST }, 201);
    await write("안내 문구 복사", `/notification-targets/${target.id}/copies`, { action: "COPY", actedAt: PAST }, 201);
    const sent = await write("안내 발송 시도", `/notification-targets/${target.id}/attempts`, { channel: "SMS", messageSnapshot: "도서가 준비되었습니다", attemptedAt: PAST }, 201);
    await write("안내 결과", `/notification-attempts/${sent.id}/result`, { outcome: "FAILED", note: "수신 거부", resultAt: PAST }, 201);
    await write("재안내", `/notification-targets/${target.id}/renotices`, { createdAt: PAST }, 201);

    // 직원 초대·철회 (수락·서점 개설은 계정 범위라 이 헬퍼의 대상이 아니다)
    const invitation = await write("직원 초대", "/staff-invitations", { email: "atomic-staff@shop.test", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 201);
    await write("초대 철회", `/staff-invitations/${invitation.invitation.id}/revocation`, {}, 201);

    // 직원 비활성화·복구: 대상 직원은 시드로 만든다(초대 수락은 계정 범위 경로라 이 헬퍼가 지원하지 않는다)
    const STAFF = "55555555-0000-4000-8000-0000000000aa";
    const seed = await db.connect();
    await seed.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'STAFF', true)`, [T, STAFF]);
    await seed.end();
    await write("직원 비활성화", `/members/${STAFF}/status`, { status: "INACTIVE" }, 200);
    await write("직원 복구", `/members/${STAFF}/status`, { status: "ACTIVE" }, 200);
    expect(faulted.slice(before)).toEqual(expect.arrayContaining(["환급 업무", "환급 요청", "환급 시도 보고", "환급 시도 해소", "환급 요청 결정", "안내 대상", "안내 문구 복사", "안내 발송 시도", "안내 결과", "재안내", "직원 초대", "초대 철회", "직원 비활성화", "직원 복구"]));
  });

  it("공급처 회신·발주 취소 요청·응답·확정·미전달 발주 취소·배정 해제·중복 위험 승인 쓰기 명령", async () => {
    const before = faulted.length;
    const book = await write("도서 등록(발주후속)", "/books", { source: "MANUAL", title: "발주후속 책", listPriceKrw: "5000", reason: "수기 등록", registeredAt: PAST }, 201);
    await write("공급처 등록(발주후속)", "/suppliers", { code: "atomic-po", name: "발주후속 도매", orderChannel: "EMAIL", registeredAt: PAST }, 201);
    const lineOf = async (label: string, quantity: number) => {
      const order = await write(`주문 생성(${label})`, "/orders", { lines: [{ bookId: book.id, quantity, unitPriceKrw: "5000" }] }, 201);
      const confirmed = await write(`주문 확정(${label})`, `/orders/${order.id}/confirm`, { expectedVersion: 1 }, 200);
      return { orderId: order.id as string, lineId: confirmed.lines[0].lineId as string };
    };
    const purchaseOrderOf = async (label: string, line: { orderId: string; lineId: string }, quantity: number, send: boolean) => {
      const sourcing = await write(`조달 배정(${label})`, `/orders/${line.orderId}/lines/${line.lineId}/sourcing-allocations`, { supplierCode: "atomic-po", quantity }, 201);
      const po = await write(`발주 생성(${label})`, "/purchase-orders", { supplierCode: "atomic-po", allocationIds: [sourcing.id] }, 201);
      if (send) {
        await write(`발주 준비(${label})`, `/purchase-orders/${po.id}/ready`, { expectedVersion: 1 }, 200);
        await write(`발주 전달(${label})`, `/purchase-orders/${po.id}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: PAST }, 200);
      }
      const got = (await call("GET", `/purchase-orders/${po.id}`)).body.data;
      return { poId: po.id as string, poLineId: got.lines[0].poLineId as string, version: got.version as number, allocationId: sourcing.id as string };
    };

    // 전달한 발주: 공급처 회신 → 취소 요청 → 응답 → 취소 확정
    const sent = await purchaseOrderOf("회신", await lineOf("회신", 2), 2, true);
    await write("공급처 회신", `/purchase-orders/${sent.poId}/supplier-replies`, { poLineId: sent.poLineId, kind: "CONFIRM", quantity: 2, source: "UNANSWERED", evidence: "공급처 확인 메일", repliedAt: PAST }, 201);
    const cancelRequest = await write("발주 취소 요청", `/purchase-orders/${sent.poId}/lines/${sent.poLineId}/cancellation-requests`, { quantity: 2, reason: "주문 취소" }, 201);
    await write("발주 취소 응답", `/purchase-orders/${sent.poId}/cancellation-requests/${cancelRequest.id}/responses`, { acceptedQuantity: 2, rejectedQuantity: 0, evidence: "공급처 취소 수락", repliedAt: PAST }, 201);
    const sentVersion = (await call("GET", `/purchase-orders/${sent.poId}`)).body.data.version as number;
    await write("발주 취소 확정", `/purchase-orders/${sent.poId}/cancellation-confirmation`, { expectedVersion: sentVersion }, 200);

    // 전달하지 않은 발주 취소
    const unsent = await purchaseOrderOf("미전달", await lineOf("미전달", 1), 1, false);
    await write("미전달 발주 취소", `/purchase-orders/${unsent.poId}/cancellation`, { expectedVersion: unsent.version, reason: "발주 철회", cancelledAt: PAST }, 200);

    // 발주에 묶이지 않은 배정 해제
    const freeLine = await lineOf("해제", 1);
    const free = await write("조달 배정(해제)", `/orders/${freeLine.orderId}/lines/${freeLine.lineId}/sourcing-allocations`, { supplierCode: "atomic-po", quantity: 1 }, 201);
    await write("배정 해제", `/sourcing-allocations/${free.id}/releases`, { reason: "배정 취소", releasedAt: PAST }, 201);

    // 전달된 발주의 배정을 풀어 공급처 의무를 남기고 중복 위험을 승인한다
    const riskLine = await lineOf("위험", 2);
    const risk = await purchaseOrderOf("위험", riskLine, 2, true);
    await write("배정 해제(의무 남음)", `/sourcing-allocations/${risk.allocationId}/releases`, { reason: "고객이 주문 변경", releasedAt: PAST }, 201);
    await write("중복 위험 승인", `/orders/${riskLine.orderId}/lines/${riskLine.lineId}/duplicate-risk-approvals`, { purchaseOrderId: risk.poId, poLineId: risk.poLineId, surplusPlan: "STOCK_INTAKE", planNote: "남는 수량은 재고로 편입", approvedAt: PAST }, 201);
    expect(faulted.slice(before)).toEqual(expect.arrayContaining(["공급처 회신", "발주 취소 요청", "발주 취소 응답", "발주 취소 확정", "미전달 발주 취소", "배정 해제", "배정 해제(의무 남음)", "중복 위험 승인"]));
  });

  it("서점 범위 쓰기(POST) 경로 전부가 위 시나리오에서 실패 주입을 거쳤다 (빠진 경로가 있으면 이름이 나온다)", () => {
    const all = app.routes.filter((r) => r.scope === "tenant" && r.method === "POST").map((r) => r.template).sort();
    const missing = all.filter((template) => !coveredTemplates.has(template));
    expect(all.length).toBeGreaterThan(55);
    expect(missing).toEqual([]);
  });
});

