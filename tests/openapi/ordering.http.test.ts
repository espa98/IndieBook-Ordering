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

  it("모든 본문 필드는 타입(type/enum/oneOf/$ref 중 하나)을 선언한다", () => {
    const untyped: string[] = [];
    for (const { key, op } of operations(load(HTTP_SPEC))) {
      const props: Json = op.requestBody?.content?.["application/json"]?.schema?.properties ?? {};
      for (const [name, schema] of Object.entries<Json>(props)) {
        if (!("type" in schema || "enum" in schema || "oneOf" in schema || "$ref" in schema)) untyped.push(`${key} .${name}`);
      }
    }
    expect(untyped).toEqual([]);
  });

  it("필드 이름 규칙과 타입이 맞는다: 수량·버전은 integer, *At은 date-time, eta는 date, *Krw는 string", () => {
    const wrong: string[] = [];
    for (const { key, op } of operations(load(HTTP_SPEC))) {
      const props: Json = op.requestBody?.content?.["application/json"]?.schema?.properties ?? {};
      for (const [name, schema] of Object.entries<Json>(props)) {
        if (/(^quantity$|Quantity$|^expectedVersion$|^fileVersion$)/.test(name) && schema.type !== "integer") wrong.push(`${key} .${name}`);
        if (/At$/.test(name) && (schema.type !== "string" || schema.format !== "date-time")) wrong.push(`${key} .${name}`);
        if (name === "eta" && (schema.type !== "string" || schema.format !== "date")) wrong.push(`${key} .${name}`);
        if (/Krw$/.test(name) && schema.type !== "string") wrong.push(`${key} .${name}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("본문 필드의 필수 여부는 도메인 요청 타입과 같다: 아래 선택 필드만 required에서 빠진다", () => {
    // 출처: 각 도메인 요청 타입(`src/db/pg*Api.ts`의 Body)에서 `?`로 선언된 필드를 tsc로 뽑았다(2026-11-25).
    // 이 목록과 required가 어긋나면 명세나 도메인 타입 중 하나가 바뀐 것이다.
    const OPTIONAL = new Set([
      "POST /return-requests/{requestId}/dispatches referenceNumber",
      "POST /orders/{orderId}/notification-targets mode",
      "POST /books authors", "POST /books isbn", "POST /books externalId", "POST /books fetchedAt", "POST /books reason", "POST /books acknowledgeDuplicateOf",
      "POST /books/{bookId}/updates acknowledgeDuplicateOf",
      "POST /purchase-orders/{purchaseOrderId}/delivery referenceNumber",
      "POST /purchase-orders/{purchaseOrderId}/delivery fileVersion",
      "POST /purchase-orders/{purchaseOrderId}/supplier-replies source",
      "POST /purchase-orders/{purchaseOrderId}/supplier-replies eta",
    ]);
    const problems: string[] = [];
    for (const { key, path, op } of operations(load(HTTP_SPEC))) {
      const schema: Json | undefined = op.requestBody?.content?.["application/json"]?.schema;
      if (!schema?.properties) continue;
      const route = `POST ${path.replace("/v1/tenants/{tenantId}", "")}`;
      const required = new Set<string>(schema.required ?? []);
      for (const name of Object.keys(schema.properties)) {
        const optional = OPTIONAL.has(`${route} ${name}`);
        if (optional === required.has(name)) problems.push(`${key} .${name} ${optional ? "선택인데 required에 있음" : "필수인데 required에 없음"}`);
      }
      for (const name of required) if (!(name in schema.properties)) problems.push(`${key} .${name} required가 properties에 없음`);
    }
    expect(problems).toEqual([]);
  });

  it("열거 필드는 도메인 요청 타입이 허용하는 값만 enum으로 선언한다", () => {
    // 출처: 각 도메인 요청 타입의 리터럴 유니온(tsc로 후보 값마다 허용 여부를 판정, 2026-11-25).
    // 도서 등록 source의 YES24는 도메인 검증(registerBook.ts)에 따른다.
    const EXPECTED: Record<string, string[]> = {
      "POST /books/{bookId}/stock-adjustments direction": ["IN", "OUT"],
      "POST /order-cancellation-requests/{requestId}/decision decision": ["APPROVED", "REJECTED", "WITHDRAWN"],
      "POST /return-requests/{requestId}/exceptions kind": ["LOST", "REFUSED", "RETURNED_BACK"],
      "POST /return-exceptions/{exceptionId}/resolutions outcome": ["RECOVERED", "RETURNED"],
      "POST /orders/{orderId}/payments method": ["BANK_TRANSFER", "CARD", "EASY_PAY"],
      "POST /refund-tasks/{taskId}/refund-attempts result": ["FAILED", "UNKNOWN"],
      "POST /refund-attempts/{attemptId}/resolution outcome": ["CONFIRMED", "FAILED"],
      "POST /orders/{orderId}/notification-targets mode": ["FULL", "PARTIAL"],
      "POST /notification-targets/{targetId}/copies action": ["COPY", "PREVIEW", "SHARE"],
      "POST /notification-targets/{targetId}/attempts channel": ["MESSENGER", "OTHER", "PHONE", "SMS", "VISIT"],
      "POST /notification-attempts/{attemptId}/result outcome": ["FAILED", "MANUAL_RECORDED"],
      "POST /books source": ["MANUAL", "YES24"],
      "POST /members/{targetUserId}/status status": ["ACTIVE", "INACTIVE"],
      "POST /suppliers orderChannel": ["API", "EMAIL", "FILE", "MESSENGER", "PHONE", "WEB"],
      "POST /orders/{orderId}/lines/{lineId}/duplicate-risk-approvals surplusPlan": ["STOCK_INTAKE", "SUPPLIER_RETURN"],
      "POST /purchase-orders/{purchaseOrderId}/delivery method": ["API", "EMAIL", "FILE", "MESSENGER", "PHONE", "WEB"],
      "POST /purchase-orders/{purchaseOrderId}/supplier-replies kind": ["CONFIRM", "DELAY", "OUT_OF_STOCK"],
      "POST /purchase-orders/{purchaseOrderId}/supplier-replies source": ["DELAYED", "UNANSWERED"],
      "POST /receipts/{receiptId}/defect-resolutions kind": ["DAMAGED", "MISDELIVERED"],
      "POST /receipts/{receiptId}/defect-resolutions outcome": ["DISCARDED", "RETURNED_TO_SUPPLIER", "SUPPLIER_CREDIT"],
      "POST /receipts/{receiptId}/excess-decisions decision": ["APPROVED", "REJECTED"],
      "POST /refund-requests/{requestId}/decision decision": ["APPROVED", "REJECTED", "WITHDRAWN"],
    };
    const actual: Record<string, string[]> = {};
    for (const { path, method, op } of operations(load(HTTP_SPEC))) {
      const props: Json = op.requestBody?.content?.["application/json"]?.schema?.properties ?? {};
      for (const [name, schema] of Object.entries<Json>(props)) {
        if (schema.enum) actual[`${method.toUpperCase()} ${path.replace("/v1/tenants/{tenantId}", "")} ${name}`] = [...schema.enum].sort();
      }
    }
    const sorted = (o: Record<string, string[]>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    expect(sorted(actual)).toEqual(sorted(EXPECTED));
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
