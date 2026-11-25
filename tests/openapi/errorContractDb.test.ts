import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * DB가 필요한 공통 오류(403 비멤버, 404 없는 대상)를 모든 서점 범위 경로에서 실제로 일으켜
 * 상태·명세 선언·`ErrorBody`를 확인한다. 경로별 특수한 409·422는 여기서 다루지 않는다.
 */
const SECRET = "error-contract-db-secret-0123456789abcdef";
const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";
const MISSING = "0a000000-0000-4000-8000-0000000000ff";
const SPECS = ["../../openapi/ordering.yaml", "../../openapi/ordering-http.yaml"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const ORDER_ROUTES = /^(GET|POST) \/v1\/tenants\/\{tenantId\}\/orders(\/\{orderId\}(\/confirm)?)?$/;

type Json = Record<string, any>;
let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T_A, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T_A, OWNER]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const nowSec = () => Math.floor(Date.now() / 1000);
const token = (sub: string) => signHs256({ sub, aud: "authenticated", role: "authenticated", exp: nowSec() + 3600, iat: nowSec() }, SECRET, { kid: "k1" });
const tenantRoutes = () => app.routes.filter((r) => r.scope === "tenant");
const specKey = (r: { method: string; template: string }) => `${r.method} /v1/tenants/{tenantId}${r.template}`;
const request = (r: { method: "GET" | "POST"; template: string }, sub: string, idFill: string, body = "{}") => ({
  method: r.method,
  path: `/v1/tenants/${T_A}${r.template}`.replace(/\{code\}/g, "missing-code").replace(/\{[^}]+\}/g, idFill),
  query: new URLSearchParams(),
  headers: { authorization: `Bearer ${token(sub)}`, ...(r.method === "POST" ? { "idempotency-key": "k-1", "content-type": "application/json" } : {}) } as Record<string, string>,
  rawBody: r.method === "POST" ? body : undefined,
});

/** 요청 스키마(참조를 푼 것)에서 형식상 유효한 최소 본문을 만든다: 필수 필드만, 정수는 최소값 이상, 시각은 과거 값, enum은 첫 값 */
function sample(schema: Json, name = ""): unknown {
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "integer":
      return Math.max(1, schema.minimum ?? 1);
    case "boolean":
      return true;
    case "array":
      return [sample(schema.items ?? {}, name)];
    case "object": {
      const props: Json = schema.properties ?? {};
      const keys: string[] = schema.required ?? [];
      const picked = keys.length > 0 ? keys : schema.minProperties ? [Object.keys(props)[0]!] : [];
      return Object.fromEntries(picked.map((k) => [k, sample(props[k] ?? {}, k)]));
    }
    default:
      if (schema.format === "date-time") return "2026-03-04T06:00:00.000Z";
      if (schema.format === "date") return "2026-03-04";
      if (schema.format === "uuid") return MISSING;
      if (/Krw$/.test(name)) return "1000";
      return "x";
  }
}
const sampleBody = (op: Json | undefined) => JSON.stringify(sample(op?.requestBody?.content?.["application/json"]?.schema ?? { type: "object" }));

async function loadOperations() {
  const ops = new Map<string, Json>();
  for (const file of SPECS) {
    const spec = (await SwaggerParser.dereference(file)) as unknown as Json;
    for (const [path, item] of Object.entries<Json>(spec.paths)) for (const m of ["get", "post"]) if (item[m]) ops.set(`${m.toUpperCase()} ${path}`, item[m]);
  }
  return ops;
}
async function check(routes: ReturnType<typeof tenantRoutes>, sub: string, idFill: string, expected: number) {
  const ops = await loadOperations();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const problems: string[] = [];
  for (const r of routes.filter((x) => !ORDER_ROUTES.test(specKey(x)))) {
    const response = await app(request(r, sub, idFill, sampleBody(ops.get(specKey(r)))));
    const key = specKey(r);
    if (response.status !== expected) {
      problems.push(`${key}: 상태 ${response.status} (기대 ${expected}) ${JSON.stringify(response.body)}`);
      continue;
    }
    const schema = ops.get(key)?.responses?.[String(expected)]?.content?.["application/json"]?.schema;
    if (!schema) problems.push(`${key}: 명세가 ${expected}를 선언하지 않음`);
    else if (!ajv.validate(schema, JSON.parse(JSON.stringify(response.body)))) problems.push(`${key}: ${ajv.errorsText()}`);
  }
  return problems;
}

/**
 * 알려진 불일치: 존재하지 않는 대상인데 404가 아닌 응답을 주는 경로. 동작을 바꾸는 일이라 사용자 결정 전에는 고치지 않았고,
 * 현재 동작을 그대로 고정한다. 고치면 이 목록의 단언이 실패해 갱신을 알려 준다.
 */
const KNOWN_GAPS: Record<string, { status: number; why: string }> = {
  "POST /v1/tenants/{tenantId}/books/{bookId}/initial-stock": { status: 201, why: "없는 도서 ID에도 초기 재고가 기록된다(재고 원장의 도서 키가 도서 테이블과 연결되어 있지 않음)" },
  "POST /v1/tenants/{tenantId}/books/{bookId}/stock-adjustments": { status: 201, why: "없는 도서 ID에도 재고 조정이 기록된다" },
  "POST /v1/tenants/{tenantId}/orders/{orderId}/lines/{lineId}/duplicate-risk-approvals": { status: 422, why: "없는 주문 품목을 404가 아니라 '열린 공급처 의무 없음'(BUSINESS_INVARIANT)으로 거부한다" },
};
const gapKey = (r: { method: string; template: string }) => specKey(r);

describe("오류 응답 계약(DB): 모든 서점 범위 경로의 공통 오류", () => {
  it("서점의 멤버가 아닌 사용자의 요청은 모든 경로에서 403이고, 명세가 선언하며, 본문이 ErrorBody를 만족한다", async () => {
    expect(await check(tenantRoutes(), STRANGER, MISSING, 403)).toEqual([]);
  });

  it("멤버가 존재하지 않는 대상(UUID 형식은 맞음)을 가리키면 알려진 불일치를 뺀 모든 경로에서 404이고, 명세가 선언하며, 본문이 ErrorBody를 만족한다", async () => {
    const withTarget = tenantRoutes().filter((r) => /\{(?!code\})[^}]+\}/.test(r.template) && !(gapKey(r) in KNOWN_GAPS));
    expect(withTarget.length).toBeGreaterThan(40);
    // GET이 POST의 부수 효과(없는 도서에 기록된 재고)를 보지 않도록 GET을 먼저 확인한다
    expect(await check(withTarget.filter((r) => r.method === "GET"), OWNER, MISSING, 404)).toEqual([]);
    expect(await check(withTarget.filter((r) => r.method === "POST"), OWNER, MISSING, 404)).toEqual([]);
  });

  it("알려진 불일치는 현재 동작 그대로다 (고치면 이 단언이 실패해 목록 갱신을 알려 준다)", async () => {
    const ops = await loadOperations();
    for (const r of tenantRoutes().filter((x) => gapKey(x) in KNOWN_GAPS)) {
      const response = await app(request(r, OWNER, MISSING, sampleBody(ops.get(specKey(r)))));
      expect(response.status, `${gapKey(r)}: ${KNOWN_GAPS[gapKey(r)]!.why}`).toBe(KNOWN_GAPS[gapKey(r)]!.status);
    }
  });
});
