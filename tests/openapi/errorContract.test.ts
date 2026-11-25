import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import { signHs256 } from "../helpers/jwtSign";

/**
 * DB 없이 판정되는 오류(인증 다음, 서점 확인 전)가 명세에 선언된 상태 코드이고 본문이 `ErrorBody`를 따르는지 모든 경로에서 확인한다.
 * 이 앱은 DB에 접속하려 하면 즉시 실패하는 풀을 쓰므로, 요청이 DB까지 갔다면 테스트가 500으로 드러낸다.
 */
const SECRET = "error-contract-secret-0123456789abcdef";
const UUID = "0a000000-0000-4000-8000-000000000001";
const SPECS = ["../../openapi/ordering.yaml", "../../openapi/ordering-http.yaml"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

type Json = Record<string, any>;
const app = createApp({
  pool: { connect: () => Promise.reject(new Error("no database in this test")) } as never,
  jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" },
});
const nowSec = () => Math.floor(Date.now() / 1000);
const authorization = () => `Bearer ${signHs256({ sub: UUID, aud: "authenticated", role: "authenticated", exp: nowSec() + 3600, iat: nowSec() }, SECRET, { kid: "k1" })}`;
const prefix = (r: { scope: "tenant" | "account" }) => (r.scope === "account" ? "/v1" : `/v1/tenants/${UUID}`);
const pathOf = (r: { scope: "tenant" | "account"; template: string }, fill = UUID) => `${prefix(r)}${r.template}`.replace(/\{code\}/g, "alpha").replace(/\{[^}]+\}/g, fill);

async function loadOperations() {
  const ops = new Map<string, Json>();
  for (const file of SPECS) {
    const spec = (await SwaggerParser.dereference(file)) as unknown as Json;
    for (const [path, item] of Object.entries<Json>(spec.paths)) {
      for (const method of ["get", "post"]) if (item[method]) ops.set(`${method.toUpperCase()} ${path}`, item[method]);
    }
  }
  return ops;
}
/** 주문 4개 경로는 `ordering.yaml`(도메인 계약 테스트)이 기술한다. 그 테스트는 도메인 API를 동기로 호출해 HTTP 계층 오류(405·415·쿼리 400)를 만들 수 없어 여기서 제외한다 */
const ORDER_ROUTES = /^(GET|POST) \/v1\/tenants\/\{tenantId\}\/orders(\/\{orderId\}(\/confirm)?)?$/;
const specKey = (r: { method: string; scope: "tenant" | "account"; template: string }) => `${r.method} ${r.scope === "account" ? "/v1" : "/v1/tenants/{tenantId}"}${r.template}`;

type Case = { name: string; applies: (r: (typeof app.routes)[number]) => boolean; expected: number; request: (r: (typeof app.routes)[number]) => Parameters<typeof app>[0] };
const base = (r: (typeof app.routes)[number]) => ({ method: r.method, path: pathOf(r), query: new URLSearchParams(), headers: { authorization: authorization() } as Record<string, string>, rawBody: undefined as string | undefined });
const post = (r: (typeof app.routes)[number], overrides: { headers?: Record<string, string>; rawBody?: string }) => {
  const b = base(r);
  return { ...b, headers: { ...b.headers, "idempotency-key": "k-1", "content-type": "application/json", ...overrides.headers }, rawBody: overrides.rawBody };
};
const isPost = (r: (typeof app.routes)[number]) => r.method === "POST";
const hasFields = (r: (typeof app.routes)[number]) => isPost(r) && (r.fields?.length ?? 0) > 0;

const CASES: Case[] = [
  { name: "알 수 없는 쿼리 → 400", applies: () => true, expected: 400, request: (r) => ({ ...base(r), query: new URLSearchParams("__unknown__=1") }) },
  { name: "경로 식별자가 UUID가 아님 → 404", applies: (r) => /\{(?!code\})[^}]+\}/.test(r.template), expected: 404, request: (r) => ({ ...base(r), path: pathOf(r, "not-a-uuid") }) },
  { name: "Idempotency-Key 없음 → 400", applies: isPost, expected: 400, request: (r) => { const { "idempotency-key": _omitted, ...headers } = post(r, { rawBody: "{}" }).headers; void _omitted; return { ...post(r, { rawBody: "{}" }), headers }; } },
  { name: "본문 없음 → 400", applies: isPost, expected: 400, request: (r) => post(r, {}) },
  { name: "JSON이 아닌 본문 → 400", applies: isPost, expected: 400, request: (r) => post(r, { rawBody: "{not json" }) },
  { name: "본문이 객체가 아님 → 400", applies: isPost, expected: 400, request: (r) => post(r, { rawBody: "[]" }) },
  { name: "알 수 없는 본문 필드 → 400", applies: isPost, expected: 400, request: (r) => post(r, { rawBody: JSON.stringify({ __unknown__: 1 }) }) },
  { name: "Content-Type이 JSON이 아님 → 415", applies: isPost, expected: 415, request: (r) => post(r, { rawBody: "{}", headers: { "content-type": "text/plain" } }) },
  { name: "허용되지 않는 메서드 → 405", applies: () => true, expected: 405, request: (r) => ({ ...base(r), method: "DELETE" as never }) },
];
void hasFields;

describe("오류 응답 계약: DB 없이 판정되는 공통 오류", () => {
  for (const c of CASES) {
    it(`${c.name}: 모든 해당 경로에서 그 상태이고, 명세가 그 상태를 선언하며, 본문이 ErrorBody를 만족한다`, async () => {
      const ops = await loadOperations();
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      const routes = app.routes.filter(c.applies).filter((r) => !ORDER_ROUTES.test(specKey(r)));
      expect(routes.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const r of routes) {
        const response = await app(c.request(r));
        const key = specKey(r);
        if (response.status !== c.expected) {
          problems.push(`${key}: 상태 ${response.status} (기대 ${c.expected})`);
          continue;
        }
        if (c.expected === 405 && !response.headers?.allow) problems.push(`${key}: 405 응답에 Allow 헤더가 없음`);
        const declared = ops.get(key)?.responses?.[String(response.status)];
        if (!declared) {
          problems.push(`${key}: 명세가 ${response.status}를 선언하지 않음`);
          continue;
        }
        const schema = declared.content?.["application/json"]?.schema;
        if (!schema) problems.push(`${key}: ${response.status} 응답 본문 스키마 없음`);
        else if (!ajv.validate(schema, JSON.parse(JSON.stringify(response.body)))) problems.push(`${key}: ${ajv.errorsText()}`);
      }
      expect(problems).toEqual([]);
    });
  }
});
