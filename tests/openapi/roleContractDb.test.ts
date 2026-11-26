import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";
import { loadOperations, MISSING, sampleBody, specKey } from "../helpers/httpContract";

/**
 * 역할별 403: Owner 전용 명령을 직원(STAFF)이 호출하면 모든 경로에서 403이고, 명세가 선언하며, 본문이 `ErrorBody`를 만족한다.
 * 기대값은 이 파일의 짐작이 아니라 `src/auth/authorizedActions.ts`의 `allow: OWNER` 목록에서 가져온다.
 */
const SECRET = "role-contract-db-secret-0123456789abcdef";
const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";
const STAFF = "11111111-0000-4000-8000-000000000002";
const DELEGATE = "11111111-0000-4000-8000-000000000004"; // 재고 조정·공급처·문구 템플릿 관리를 위임받은 직원
const EX_STAFF = "11111111-0000-4000-8000-000000000005"; // 비활성화된 직원
const EX_OWNER = "11111111-0000-4000-8000-000000000006"; // 비활성화된 점주(다른 활성 Owner가 있어 비활성화할 수 있다)
const EX_DELEGATE = "11111111-0000-4000-8000-000000000007"; // 위임이 남아 있지만 비활성화된 직원

/** Owner 전용 명령 → 그 명령을 실행하는 HTTP 경로. 계정 범위 경로(`/v1/...`)는 해당 없다 */
const OWNER_ONLY_ROUTES: Record<string, string> = {
  correctFulfillment: "POST /v1/tenants/{tenantId}/orders/{orderId}/fulfillments/{fulfillmentId}/corrections",
  cancelAllocation: "POST /v1/tenants/{tenantId}/allocations/{allocationId}/cancellations",
  correctReceipt: "POST /v1/tenants/{tenantId}/receipts/{receiptId}/corrections",
  decideExcessReceipt: "POST /v1/tenants/{tenantId}/receipts/{receiptId}/excess-decisions",
  registerInitialStock: "POST /v1/tenants/{tenantId}/books/{bookId}/initial-stock",
  requestReturn: "POST /v1/tenants/{tenantId}/allocation-cancellations/{cancellationId}/return-requests",
  transferCancelledToStock: "POST /v1/tenants/{tenantId}/allocation-cancellations/{cancellationId}/stock-intakes",
  applyOrderCancellation: "POST /v1/tenants/{tenantId}/order-cancellation-requests/{requestId}/application",
  correctPayment: "POST /v1/tenants/{tenantId}/payments/{paymentId}/corrections",
  approveDuplicateRisk: "POST /v1/tenants/{tenantId}/orders/{orderId}/lines/{lineId}/duplicate-risk-approvals",
  inviteStaff: "POST /v1/tenants/{tenantId}/staff-invitations",
  revokeInvitation: "POST /v1/tenants/{tenantId}/staff-invitations/{invitationId}/revocation",
  setMembershipStatus: "POST /v1/tenants/{tenantId}/members/{targetUserId}/status",
  setDelegation: "POST /v1/tenants/{tenantId}/members/{targetUserId}/delegations",
  updateStoreSettings: "POST /v1/tenants/{tenantId}/store/settings",
  anonymizeCustomer: "POST /v1/tenants/{tenantId}/customers/{customerId}/anonymization",
};
/** Owner만 읽는 조회 경로(권한 규칙이 명령 모음이 아니라 어댑터에 있다) */
const OWNER_ONLY_READS = ["GET /v1/tenants/{tenantId}/audit-log", "GET /v1/tenants/{tenantId}/members", "GET /v1/tenants/{tenantId}/staff-invitations", "GET /v1/tenants/{tenantId}/delegations"];
/** Owner 전용이지만 HTTP 경로가 없는 명령(다른 명령 안에서만 실행된다) */
const OWNER_ONLY_WITHOUT_ROUTE = ["confirmRefund"];

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', true)`, [T_A, OWNER, STAFF, DELEGATE]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'STAFF', false), ($1, $3, 'OWNER', false), ($1, $4, 'STAFF', false)`, [T_A, EX_STAFF, EX_OWNER, EX_DELEGATE]);
  await c.query(`insert into public.ordering_stock_delegations (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, now()), ($1, $4, $3, now())`, [T_A, DELEGATE, OWNER, EX_DELEGATE]);
  await c.query(`insert into public.ordering_management_delegations (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, now())`, [T_A, EX_DELEGATE, OWNER]);
  await c.query(`insert into public.ordering_management_delegations (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, now())`, [T_A, DELEGATE, OWNER]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const nowSec = () => Math.floor(Date.now() / 1000);
const token = (sub: string) => signHs256({ sub, aud: "authenticated", role: "authenticated", exp: nowSec() + 3600, iat: nowSec() }, SECRET, { kid: "k1" });
const request = (r: { method: "GET" | "POST"; template: string }, sub: string, body: string) => ({
  method: r.method,
  path: `/v1/tenants/${T_A}${r.template}`.replace(/\{code\}/g, "missing-code").replace(/\{[^}]+\}/g, MISSING),
  query: new URLSearchParams(),
  headers: { authorization: `Bearer ${token(sub)}`, "idempotency-key": "k-1", "content-type": "application/json" } as Record<string, string>,
  rawBody: body,
});
/** `authorizedActions.ts` 원문에서 `allow: OWNER`인 명령 이름을 읽는다 */
const ownerOnlyCommands = () => {
  const source = readFileSync(fileURLToPath(new URL("../../src/auth/authorizedActions.ts", import.meta.url)), "utf8");
  return [...source.matchAll(/^\s+(\w+): bindActor\([^\n]*allow: OWNER \}\)/gm)].map((m) => m[1]!).sort();
};

describe("역할별 403: Owner 전용 명령", () => {
  it("경로 표가 authorizedActions의 Owner 전용 명령과 정확히 일치한다 (새 Owner 전용 명령을 표에 넣지 않으면 실패한다)", () => {
    expect([...Object.keys(OWNER_ONLY_ROUTES), ...OWNER_ONLY_WITHOUT_ROUTE].sort()).toEqual(ownerOnlyCommands());
  });

  it("직원이 Owner 전용 경로를 호출하면 모두 403이고, 명세가 선언하며, 본문이 ErrorBody를 만족한다 (대상이 없어도 권한이 먼저다)", async () => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const problems: string[] = [];
    for (const r of app.routes.filter((x) => Object.values(OWNER_ONLY_ROUTES).includes(specKey(x)))) {
      const key = specKey(r);
      const response = await app(request(r, STAFF, sampleBody(ops.get(key))));
      if (response.status !== 403) {
        problems.push(`${key}: 상태 ${response.status} (기대 403) ${JSON.stringify(response.body)}`);
        continue;
      }
      const schema = ops.get(key)?.responses?.["403"]?.content?.["application/json"]?.schema;
      if (!schema) problems.push(`${key}: 명세가 403을 선언하지 않음`);
      else if (!ajv.validate(schema, JSON.parse(JSON.stringify(response.body)))) problems.push(`${key}: ${ajv.errorsText()}`);
    }
    expect(problems).toEqual([]);
  });

  it("표의 경로는 실제로 서버에 있다", () => {
    const served = new Set(app.routes.map((r) => specKey(r)));
    expect(Object.values(OWNER_ONLY_ROUTES).filter((k) => !served.has(k))).toEqual([]);
  });
});

/** 허용되는 쪽과 막히는 쪽을 쌍으로 확인한다: 막히는 쪽만 보면 모든 직원 요청을 막아 버리는 구현도 통과한다 */
type Partial = { name: string; route: string; override?: Record<string, unknown>; actor: "STAFF" | "DELEGATE"; expect: "FORBIDDEN" | "ALLOWED"; rule: string };
/** 템플릿 키는 대문자 스네이크 형식이어야 입력 검증을 지난다(요청 스키마에는 아직 이 형식 제약이 없다) */
const TEMPLATE_BODY = { key: "ORDER_READY", body: "{{storeName}}입니다" };
const PARTIAL: Partial[] = [
  // 결정 종류에 따라: 승인·거절은 Owner 업무(DEC-09), 철회는 직원도 가능
  { name: "주문 취소 요청 승인", route: "POST /v1/tenants/{tenantId}/order-cancellation-requests/{requestId}/decision", override: { decision: "APPROVED" }, actor: "STAFF", expect: "FORBIDDEN", rule: "승인·거절은 Owner" },
  { name: "주문 취소 요청 철회", route: "POST /v1/tenants/{tenantId}/order-cancellation-requests/{requestId}/decision", override: { decision: "WITHDRAWN" }, actor: "STAFF", expect: "ALLOWED", rule: "철회는 직원도 가능" },
  { name: "환급 요청 승인", route: "POST /v1/tenants/{tenantId}/refund-requests/{requestId}/decision", override: { decision: "APPROVED" }, actor: "STAFF", expect: "FORBIDDEN", rule: "승인·거절은 Owner" },
  { name: "환급 요청 철회", route: "POST /v1/tenants/{tenantId}/refund-requests/{requestId}/decision", override: { decision: "WITHDRAWN" }, actor: "STAFF", expect: "ALLOWED", rule: "철회는 직원도 가능" },
  // 처분 결과에 따라: 폐기는 Owner 업무
  { name: "입고 불량 폐기", route: "POST /v1/tenants/{tenantId}/receipts/{receiptId}/defect-resolutions", override: { outcome: "DISCARDED" }, actor: "STAFF", expect: "FORBIDDEN", rule: "폐기는 Owner" },
  { name: "입고 불량 공급처 반품", route: "POST /v1/tenants/{tenantId}/receipts/{receiptId}/defect-resolutions", override: { outcome: "RETURNED_TO_SUPPLIER" }, actor: "STAFF", expect: "ALLOWED", rule: "폐기 외 처분은 직원도 가능" },
  // 재고 조정은 Owner 또는 위임된 직원
  { name: "재고 조정(위임 없음)", route: "POST /v1/tenants/{tenantId}/books/{bookId}/stock-adjustments", actor: "STAFF", expect: "FORBIDDEN", rule: "위임 없는 직원은 불가" },
  { name: "재고 조정(위임됨)", route: "POST /v1/tenants/{tenantId}/books/{bookId}/stock-adjustments", actor: "DELEGATE", expect: "ALLOWED", rule: "위임된 직원은 가능" },
  // 공급처·문구 템플릿 관리는 Owner 또는 위임된 직원
  { name: "공급처 등록(위임 없음)", route: "POST /v1/tenants/{tenantId}/suppliers", actor: "STAFF", expect: "FORBIDDEN", rule: "위임 없는 직원은 불가" },
  { name: "공급처 등록(위임됨)", route: "POST /v1/tenants/{tenantId}/suppliers", actor: "DELEGATE", expect: "ALLOWED", rule: "위임된 직원은 가능" },
  { name: "공급처 수정(위임 없음)", route: "POST /v1/tenants/{tenantId}/suppliers/{code}/updates", actor: "STAFF", expect: "FORBIDDEN", rule: "위임 없는 직원은 불가" },
  { name: "공급처 수정(위임됨)", route: "POST /v1/tenants/{tenantId}/suppliers/{code}/updates", actor: "DELEGATE", expect: "ALLOWED", rule: "위임된 직원은 가능" },
  { name: "공급처 활성 전환(위임 없음)", route: "POST /v1/tenants/{tenantId}/suppliers/{code}/activation", actor: "STAFF", expect: "FORBIDDEN", rule: "위임 없는 직원은 불가" },
  { name: "공급처 활성 전환(위임됨)", route: "POST /v1/tenants/{tenantId}/suppliers/{code}/activation", actor: "DELEGATE", expect: "ALLOWED", rule: "위임된 직원은 가능" },
  { name: "문구 템플릿 게시(위임 없음)", route: "POST /v1/tenants/{tenantId}/message-templates", override: TEMPLATE_BODY, actor: "STAFF", expect: "FORBIDDEN", rule: "위임 없는 직원은 불가" },
  { name: "문구 템플릿 게시(위임됨)", route: "POST /v1/tenants/{tenantId}/message-templates", override: TEMPLATE_BODY, actor: "DELEGATE", expect: "ALLOWED", rule: "위임된 직원은 가능" },
];

describe("역할별 403: 직원에게 일부만 허용되는 명령", () => {
  it("막히는 쪽은 403(명세 선언·ErrorBody 포함)이고, 허용되는 쪽은 권한 규칙까지 도달한다(400·401·403·500이 아님)", async () => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const actors = { STAFF, DELEGATE };
    const problems: string[] = [];
    for (const c of PARTIAL) {
      const r = app.routes.find((x) => specKey(x) === c.route);
      if (!r) {
        problems.push(`${c.name}: 서버에 경로가 없음 (${c.route})`);
        continue;
      }
      const body = JSON.stringify({ ...(JSON.parse(sampleBody(ops.get(c.route))) as Record<string, unknown>), ...(c.override ?? {}) });
      const response = await app(request(r, actors[c.actor], body));
      if (c.expect === "FORBIDDEN") {
        if (response.status !== 403) {
          problems.push(`${c.name}: 상태 ${response.status} (기대 403, ${c.rule}) ${JSON.stringify(response.body)}`);
          continue;
        }
        const schema = ops.get(c.route)?.responses?.["403"]?.content?.["application/json"]?.schema;
        if (!schema) problems.push(`${c.name}: 명세가 403을 선언하지 않음`);
        else if (!ajv.validate(schema, JSON.parse(JSON.stringify(response.body)))) problems.push(`${c.name}: ${ajv.errorsText()}`);
      } else if ([400, 401, 403, 500].includes(response.status)) {
        // 400이면 입력 검증에서 걸린 것이라 권한 규칙까지 도달하지 못했다: 허용 쪽 확인이 의미가 없다
        problems.push(`${c.name}: 상태 ${response.status} (허용되어야 함, ${c.rule}) ${JSON.stringify(response.body)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(OWNER_ONLY_READS)("%s는 Owner만 읽는다: 직원은 403이고 Owner는 200이다", async (route) => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const r = app.routes.find((x) => specKey(x) === route)!;
    const get = (sub: string) => app({ ...request(r, sub, ""), rawBody: undefined });

    const denied = await get(STAFF);
    expect(denied.status).toBe(403);
    expect(ajv.validate(ops.get(route)!.responses["403"].content["application/json"].schema, JSON.parse(JSON.stringify(denied.body))), ajv.errorsText()).toBe(true);
    expect((await get(OWNER)).status).toBe(200);
    expect((await get(DELEGATE)).status).toBe(403); // 위임은 Owner 전용 조회와 무관하다
    expect((await get(EX_OWNER)).status).toBe(403); // 비활성 Owner도 못 읽는다
  });
});

describe("역할별 403: 직원에게 허용된 나머지 경로 (역방향)", () => {
  it("Owner 전용·부분 허용·감사 로그를 뺀 모든 서점 범위 경로는 직원에게 403이 아니다 (권한을 너무 좁게 막지 않는다)", async () => {
    // 전체 허용 명령은 권한 검사가 입력 검증보다 앞서므로, 직원이 막혔다면 400이 아니라 403이 먼저 나온다
    const classified = new Set([
      ...Object.values(OWNER_ONLY_ROUTES),
      ...PARTIAL.map((c) => c.route),
      ...OWNER_ONLY_READS,
    ]);
    const ops = await loadOperations();
    const rest = app.routes.filter((r) => r.scope === "tenant" && !classified.has(specKey(r)));
    expect(rest.length).toBeGreaterThan(40);

    const problems: string[] = [];
    for (const r of rest) {
      const key = specKey(r);
      const response = await app(r.method === "POST" ? request(r, STAFF, sampleBody(ops.get(key))) : { ...request(r, STAFF, ""), rawBody: undefined });
      if ([401, 403, 500].includes(response.status)) problems.push(`${key}: 상태 ${response.status} ${JSON.stringify(response.body)}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("역할별 403: 대상에 따라 갈리는 규칙", () => {
  let seq = 0;
  const call = async (sub: string, method: "GET" | "POST", path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token(sub)}` };
    if (method === "POST") headers["idempotency-key"] = `role-${++seq}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await app({ method, path: `/v1/tenants/${T_A}${path}`, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
  };
  const must = async (res: Promise<{ status: number; body: any }>, status: number, what: string) => {
    const r = await res;
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(status);
    return r.body.data;
  };

  it("다른 고객의 주문으로 재배분하는 것은 Owner만 하고(DEC-15), 같은 주문 안에서 옮기는 것은 직원도 할 수 있다", async () => {
    // 한 발주에 두 고객의 주문 품목을 묶어 입고하고, 첫 고객에게 배분해 둔다
    await must(call(OWNER, "POST", "/suppliers", { code: "role-sup", name: "역할 도매", orderChannel: "EMAIL", registeredAt: "2026-03-04T06:00:00.000Z" }), 201, "공급처 등록");
    const book = await must(call(OWNER, "POST", "/books", { source: "MANUAL", title: "재배분 책", listPriceKrw: "5000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" }), 201, "도서 등록");
    const lineOf = async (quantity: number) => {
      const order = await must(call(OWNER, "POST", "/orders", { lines: [{ bookId: book.id, quantity, unitPriceKrw: "5000" }] }), 201, "주문 생성");
      const confirmed = await must(call(OWNER, "POST", `/orders/${order.id}/confirm`, { expectedVersion: 1 }), 200, "주문 확정");
      return { orderId: order.id as string, lineId: confirmed.lines[0].lineId as string };
    };
    const first = await lineOf(3);
    const second = await lineOf(2);
    const a1 = await must(call(OWNER, "POST", `/orders/${first.orderId}/lines/${first.lineId}/sourcing-allocations`, { supplierCode: "role-sup", quantity: 3 }), 201, "배정 1");
    const a2 = await must(call(OWNER, "POST", `/orders/${second.orderId}/lines/${second.lineId}/sourcing-allocations`, { supplierCode: "role-sup", quantity: 2 }), 201, "배정 2");
    const po = await must(call(OWNER, "POST", "/purchase-orders", { supplierCode: "role-sup", allocationIds: [a1.id, a2.id] }), 201, "발주 생성");
    await must(call(OWNER, "POST", `/purchase-orders/${po.id}/ready`, { expectedVersion: 1 }), 200, "발주 준비");
    await must(call(OWNER, "POST", `/purchase-orders/${po.id}/delivery`, { expectedVersion: 2, method: "EMAIL", deliveredAt: "2026-03-04T07:00:00.000Z" }), 200, "발주 전달");
    const poLineId = (await must(call(OWNER, "GET", `/purchase-orders/${po.id}`), 200, "발주 조회")).lines[0].poLineId as string;
    const receipt = await must(call(OWNER, "POST", `/purchase-orders/${po.id}/receipts`, { poLineId, normalQuantity: 5, damagedQuantity: 0, misdeliveredQuantity: 0, receivedAt: "2026-03-05T06:00:00.000Z" }), 201, "입고");
    const allocation = await must(call(OWNER, "POST", `/receipts/${receipt.id}/allocations`, { orderId: first.orderId, orderLineId: first.lineId, quantity: 3, allocatedAt: "2026-03-05T07:00:00.000Z" }), 201, "입고 배분");
    const move = (sub: string, to: { orderId: string; lineId: string }, quantity: number) =>
      call(sub, "POST", `/allocations/${allocation.id}/reallocations`, { toOrderId: to.orderId, toOrderLineId: to.lineId, quantity, reason: "재배분", actedAt: "2026-03-05T08:00:00.000Z" });

    // 직원: 다른 고객의 주문으로는 403(명세 선언·ErrorBody 포함), 같은 주문 안에서는 허용
    const denied = await move(STAFF, second, 1);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const ops = await loadOperations();
    expect(ajv.validate(ops.get("POST /v1/tenants/{tenantId}/allocations/{allocationId}/reallocations")!.responses["403"].content["application/json"].schema, denied.body), ajv.errorsText()).toBe(true);
    expect((await move(STAFF, first, 1)).status).toBe(201);

    // Owner는 다른 고객의 주문으로도 옮긴다
    expect((await move(OWNER, second, 1)).status).toBe(201);
  });
});

describe("비활성 멤버: 역할·위임과 무관하게 모든 서점 범위 경로에서 403", () => {
  it("비활성화된 직원·점주·위임이 남은 직원은 모든 경로에서 403이고, 명세가 선언하며, 본문이 ErrorBody를 만족한다", async () => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const routes = app.routes.filter((r) => r.scope === "tenant");
    expect(routes.length).toBeGreaterThan(70);

    const problems: string[] = [];
    for (const [who, sub] of [["비활성 직원", EX_STAFF], ["비활성 점주", EX_OWNER], ["위임이 남은 비활성 직원", EX_DELEGATE]] as const) {
      for (const r of routes) {
        const key = specKey(r);
        const response = await app(r.method === "POST" ? request(r, sub, sampleBody(ops.get(key))) : { ...request(r, sub, ""), rawBody: undefined });
        if (response.status !== 403) {
          problems.push(`${who} ${key}: 상태 ${response.status} ${JSON.stringify(response.body)}`);
          continue;
        }
        const schema = ops.get(key)?.responses?.["403"]?.content?.["application/json"]?.schema;
        if (!schema) problems.push(`${who} ${key}: 명세가 403을 선언하지 않음`);
        else if (!ajv.validate(schema, JSON.parse(JSON.stringify(response.body)))) problems.push(`${who} ${key}: ${ajv.errorsText()}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

