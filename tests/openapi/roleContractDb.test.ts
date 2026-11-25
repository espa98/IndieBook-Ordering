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
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T_A, OWNER, STAFF]);
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
  path: `/v1/tenants/${T_A}${r.template}`.replace(/\{[^}]+\}/g, MISSING),
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
