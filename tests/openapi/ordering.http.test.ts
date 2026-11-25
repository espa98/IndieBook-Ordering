import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";

const ORDERS_SPEC = fileURLToPath(new URL("../../openapi/ordering.yaml", import.meta.url));
const HTTP_SPEC = fileURLToPath(new URL("../../openapi/ordering-http.yaml", import.meta.url));
const BASE = "/v1/tenants/{tenantId}";
const METHODS = ["get", "post"];

type Json = Record<string, any>;
const load = (path: string) => parse(readFileSync(path, "utf8")) as Json;
const operations = (spec: Json) =>
  Object.entries<Json>(spec.paths).flatMap(([path, item]) =>
    Object.entries<Json>(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, path, method, op })),
  );

const app = createApp({
  pool: { connect: () => Promise.reject(new Error("no database in this test")) } as never,
  jwt: { keys: [{ kid: "k1", alg: "HS256", key: new TextEncoder().encode("x".repeat(32)) as never }], audience: "authenticated" } as never,
});
/** 서점 범위 경로는 `/v1/tenants/{tenantId}`, 계정 범위 경로는 `/v1`로 시작한다 */
const prefix = (r: { scope: "tenant" | "account" }) => (r.scope === "account" ? "/v1" : BASE);
/** 서버 경로표를 명세와 같은 표기로 바꾼다: `(?<orderId>[^/]+)` → `{orderId}` */
const served = () =>
  app.routes.map((r) => ({ ...r, key: `${r.method} ${prefix(r)}${r.template}` }));

describe("openapi/ordering-http.yaml: 서버 경로표와 명세의 드리프트 방지", () => {
  it("유효한 OpenAPI 3.1 문서이다 (참조 해석 포함)", async () => {
    expect(load(HTTP_SPEC).openapi).toMatch(/^3\.1\./);
    await expect(SwaggerParser.validate(HTTP_SPEC)).resolves.toBeDefined();
  });

  it("서버가 제공하는 모든 (메서드, 경로)가 두 명세 중 하나에 정확히 한 번 있고, 명세에만 있는 경로는 없다", () => {
    const documented = [...operations(load(ORDERS_SPEC)), ...operations(load(HTTP_SPEC))].map((o) => o.key);
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(served().map((r) => r.key).sort());
  });

  it("각 경로의 성공 상태·본문 필드(허용 목록)·쿼리 파라미터·Idempotency-Key가 서버와 일치한다", () => {
    const ops = new Map([...operations(load(ORDERS_SPEC)), ...operations(load(HTTP_SPEC))].map((o) => [o.key, o]));
    // 주문 4개 경로는 ordering.yaml(도메인 계약 테스트)이 따로 검증한다
    const own = served().filter((r) => !/^(GET|POST) \/v1\/tenants\/\{tenantId\}\/orders(\/\{orderId\}(\/confirm)?)?$/.test(r.key));
    expect(own.length).toBeGreaterThan(40);
    for (const route of own) {
      const { op } = ops.get(route.key)!;
      expect(Object.keys(op.responses), `${route.key} 성공 상태`).toContain(String(route.success));
      const bodyProps = op.requestBody?.content?.["application/json"]?.schema?.properties;
      expect(Object.keys(bodyProps ?? {}).sort(), `${route.key} 본문 필드`).toEqual([...(route.fields ?? [])].sort());
      if (route.fields) expect(op.requestBody.content["application/json"].schema.additionalProperties, route.key).toBe(false);
      const query = (op.parameters ?? []).filter((p: Json) => p.in === "query").map((p: Json) => p.name);
      expect(query.sort(), `${route.key} 쿼리`).toEqual([...(route.queryFields ?? [])].sort());
      const hasKey = (op.parameters ?? []).some((p: Json) => String(p.$ref).endsWith("/components/parameters/IdempotencyKey"));
      expect(hasKey, `${route.key} Idempotency-Key`).toBe(route.method === "POST");
    }
  });

  it("모든 경로는 인증이 없으면 같은 401이고, 그 본문은 명세의 ErrorBody를 만족한다", async () => {
    const spec = (await SwaggerParser.dereference(HTTP_SPEC)) as unknown as Json;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const route of served()) {
      const path = `${prefix(route)}${route.template}`.replace(/\{[^}]+\}/g, "0a000000-0000-4000-8000-000000000001");
      const response = await app({ method: route.method, path, query: new URLSearchParams(), headers: {}, rawBody: undefined });
      expect(response.status, route.key).toBe(401);
      const declared = Object.entries<Json>(spec.paths).flatMap(([p, item]) => (item[route.method.toLowerCase()] && `${route.method} ${p}` === route.key ? [item[route.method.toLowerCase()]] : []))[0];
      if (!declared) continue; // 주문 4개 경로는 ordering.yaml 계약 테스트가 검증한다
      const schema = declared.responses["401"].content["application/json"].schema;
      expect(ajv.validate(schema, JSON.parse(JSON.stringify(response.body))), `${route.key}: ${ajv.errorsText()}`).toBe(true);
    }
  });
});
