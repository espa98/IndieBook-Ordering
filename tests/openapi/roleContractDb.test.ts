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
};
/** Owner 전용이지만 HTTP 경로가 없는 명령(다른 명령 안에서만 실행된다) */
const OWNER_ONLY_WITHOUT_ROUTE = ["confirmRefund"];

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', true)`, [T_A, OWNER, STAFF, DELEGATE]);
  await c.query(`insert into public.ordering_stock_delegations (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, now())`, [T_A, DELEGATE, OWNER]);
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

  it("GET /audit-log는 Owner만 읽는다: 직원은 403이고 Owner는 200이다", async () => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const route = "GET /v1/tenants/{tenantId}/audit-log";
    const r = app.routes.find((x) => specKey(x) === route)!;
    const get = (sub: string) => app({ ...request(r, sub, ""), rawBody: undefined });

    const denied = await get(STAFF);
    expect(denied.status).toBe(403);
    expect(ajv.validate(ops.get(route)!.responses["403"].content["application/json"].schema, JSON.parse(JSON.stringify(denied.body))), ajv.errorsText()).toBe(true);
    expect((await get(OWNER)).status).toBe(200);
    expect((await get(DELEGATE)).status).toBe(403); // 위임은 감사 로그 조회와 무관하다
  });
});
