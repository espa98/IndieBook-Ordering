import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import SwaggerParser from "@apidevtools/swagger-parser";
import { handle } from "../../src/http/handle";
import { createAnyBookRepository } from "../helpers/anyBookRepository";
import { createOrderApi } from "../../src/order/orderApi";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { createInMemoryMembershipRepository } from "../helpers/inMemoryMembershipRepository";
import { createApp } from "../../src/http/app";
import { signHs256 } from "../helpers/jwtSign";

const SPEC_PATH = fileURLToPath(new URL("../../openapi/ordering.yaml", import.meta.url));
const BASE = "/v1/tenants/{tenantId}";

type Json = Record<string, any>;
let spec: Json;

beforeAll(async () => {
  // $ref를 모두 해석한 문서: responses/schemas를 그대로 ajv에 넘길 수 있다
  spec = (await SwaggerParser.dereference(SPEC_PATH)) as unknown as Json;
});

/** 응답 본문을 스펙의 (path, method, status) 응답 스키마로 검증한다. 위반하면 ajv 오류를 메시지로 낸다. */
function expectConforms(
  path: string,
  method: string,
  response: { status: number; body: unknown },
) {
  const declared = spec.paths[path]?.[method]?.responses?.[String(response.status)];
  expect(
    declared,
    `${method.toUpperCase()} ${path}에 ${response.status} 응답이 스펙에 정의되어 있어야 한다`,
  ).toBeDefined();

  const schema = declared.content["application/json"].schema;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat("date-time", (s) => !Number.isNaN(Date.parse(s)));
  const validate = ajv.compile(schema);
  // JSON으로 직렬화한 뒤 검증해 undefined 필드가 실제 응답처럼 사라지게 한다
  const wire = JSON.parse(JSON.stringify(response.body));
  const ok = validate(wire);
  expect(ok, `스키마 위반: ${ajv.errorsText(validate.errors)}\n본문: ${JSON.stringify(wire)}`).toBe(true);
}

function setup() {
  let n = 0;
  const api = createOrderApi({
    books: createAnyBookRepository(),
    orders: createInMemoryOrderRepository(),
    idempotency: createIdempotencyStore(),
    issueDisplayNumber: () => ++n,
    memberships: createInMemoryMembershipRepository([
      { userId: "owner-a", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
      { userId: "ex-staff", tenantId: "tenant-a", role: "STAFF", status: "INACTIVE" },
    ]),
  });
  return { api, owner: { userId: "owner-a" } };
}

const lines = [{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }];

const noop = () => {};
const SUCCESS = new Set(["200", "201"]);

/** 저장소가 항상 실패하는 API: 500을 실제 코드 경로로 만든다 */
function brokenApi() {
  const down = () => {
    throw new Error("db down: password=hunter2");
  };
  return createOrderApi({
    books: createAnyBookRepository(),
    orders: { get: down, list: down, save: down },
    idempotency: createIdempotencyStore(),
    issueDisplayNumber: () => 1,
    memberships: createInMemoryMembershipRepository([
      { userId: "owner-a", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
    ]),
  });
}

type Scenario = {
  label: string;
  method: string;
  path: string;
  status: number;
  /** 도메인 API를 동기로 호출하거나, HTTP 계층 오류(405·415 등)는 앱을 비동기로 호출한다 */
  run: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
};

const O = `${BASE}/orders`;
const OID = `${BASE}/orders/{orderId}`;
const CONFIRM = `${BASE}/orders/{orderId}/confirm`;

const guard = { onUnexpectedError: noop };
const confirmReq = (orderId: string, extra: Json = {}) => ({
  tenantId: "tenant-a",
  orderId,
  expectedVersion: 1,
  idempotencyKey: "c-1",
  ...extra,
});

/**
 * HTTP 계층에서만 나오는 오류(405·415·쿼리 400)는 도메인 API로 만들 수 없어 앱을 직접 호출한다.
 * DB에 접속하려 하면 즉시 실패하는 풀을 쓰므로, 요청이 DB까지 갔다면 500으로 드러난다.
 */
const HTTP_SECRET = "order-contract-http-secret-0123456789abcdef";
const SOME_ID = "0a000000-0000-4000-8000-000000000001";
const httpApp = createApp({
  pool: { connect: () => Promise.reject(new Error("no database in this test")) } as never,
  jwt: { keys: [{ kid: "k1", alg: "HS256", key: HTTP_SECRET }], audience: "authenticated" },
});
const httpBearer = () => {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signHs256({ sub: SOME_ID, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, HTTP_SECRET, { kid: "k1" })}`;
};
async function callHttp(options: { method: string; path: string; query?: string; headers?: Record<string, string>; rawBody?: string }) {
  const response = await httpApp({
    method: options.method as "GET",
    path: options.path.replace("{tenantId}", SOME_ID).replace("{orderId}", SOME_ID),
    query: new URLSearchParams(options.query ?? ""),
    headers: { authorization: httpBearer(), ...(options.headers ?? {}) },
    rawBody: options.rawBody,
  });
  return { status: response.status, body: response.body };
}
const wrongMethod = (path: string) => () => callHttp({ method: "DELETE", path });
const notJson = (path: string) => () => callHttp({ method: "POST", path, headers: { "idempotency-key": "k-1", "content-type": "text/plain" }, rawBody: "{}" });

const scenarios: Scenario[] = [
  // GET /orders
  { label: "limit=0", method: "get", path: O, status: 400, run: () => { const { api, owner } = setup(); return handle(() => api.listOrders(owner, { tenantId: "tenant-a", limit: 0 }), guard); } },
  { label: "인증 없음", method: "get", path: O, status: 401, run: () => { const { api } = setup(); return handle(() => api.listOrders({ userId: "" }, { tenantId: "tenant-a" }), guard); } },
  { label: "비활성", method: "get", path: O, status: 403, run: () => { const { api } = setup(); return handle(() => api.listOrders({ userId: "ex-staff" }, { tenantId: "tenant-a" }), guard); } },
  { label: "저장소 장애", method: "get", path: O, status: 500, run: () => handle(() => brokenApi().listOrders({ userId: "owner-a" }, { tenantId: "tenant-a" }), guard) },
  // POST /orders
  { label: "quantity=0", method: "post", path: O, status: 400, run: () => { const { api, owner } = setup(); return handle(() => api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k", lines: [{ bookId: "b", quantity: 0, unitPriceKrw: "1" }] }), { ...guard, successStatus: 201 }); } },
  { label: "인증 없음", method: "post", path: O, status: 401, run: () => { const { api } = setup(); return handle(() => api.createOrder({ userId: "" }, { tenantId: "tenant-a", idempotencyKey: "k", lines }), { ...guard, successStatus: 201 }); } },
  { label: "비활성", method: "post", path: O, status: 403, run: () => { const { api } = setup(); return handle(() => api.createOrder({ userId: "ex-staff" }, { tenantId: "tenant-a", idempotencyKey: "k", lines }), { ...guard, successStatus: 201 }); } },
  { label: "같은 키·다른 본문", method: "post", path: O, status: 409, run: () => { const { api, owner } = setup(); const base = { tenantId: "tenant-a", idempotencyKey: "k" }; api.createOrder(owner, { ...base, lines }); return handle(() => api.createOrder(owner, { ...base, lines: [] }), { ...guard, successStatus: 201 }); } },
  { label: "저장소 장애", method: "post", path: O, status: 500, run: () => handle(() => brokenApi().createOrder({ userId: "owner-a" }, { tenantId: "tenant-a", idempotencyKey: "k", lines }), { ...guard, successStatus: 201 }) },
  // GET /orders/{orderId}
  { label: "인증 없음", method: "get", path: OID, status: 401, run: () => { const { api } = setup(); return handle(() => api.getOrder({ userId: "" }, { tenantId: "tenant-a", orderId: "x" }), guard); } },
  { label: "비활성", method: "get", path: OID, status: 403, run: () => { const { api } = setup(); return handle(() => api.getOrder({ userId: "ex-staff" }, { tenantId: "tenant-a", orderId: "x" }), guard); } },
  { label: "없는 주문", method: "get", path: OID, status: 404, run: () => { const { api, owner } = setup(); return handle(() => api.getOrder(owner, { tenantId: "tenant-a", orderId: "missing" }), guard); } },
  { label: "저장소 장애", method: "get", path: OID, status: 500, run: () => handle(() => brokenApi().getOrder({ userId: "owner-a" }, { tenantId: "tenant-a", orderId: "x" }), guard) },
  // POST /orders/{orderId}/confirm
  { label: "expectedVersion 누락", method: "post", path: CONFIRM, status: 400, run: () => { const { api, owner } = setup(); const o = api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k", lines }); return handle(() => api.confirmOrder(owner, confirmReq(o.id, { expectedVersion: undefined })), guard); } },
  { label: "인증 없음", method: "post", path: CONFIRM, status: 401, run: () => { const { api } = setup(); return handle(() => api.confirmOrder({ userId: "" }, confirmReq("x")), guard); } },
  { label: "비활성", method: "post", path: CONFIRM, status: 403, run: () => { const { api } = setup(); return handle(() => api.confirmOrder({ userId: "ex-staff" }, confirmReq("x")), guard); } },
  { label: "없는 주문", method: "post", path: CONFIRM, status: 404, run: () => { const { api, owner } = setup(); return handle(() => api.confirmOrder(owner, confirmReq("missing")), guard); } },
  { label: "VERSION_CONFLICT", method: "post", path: CONFIRM, status: 409, run: () => { const { api, owner } = setup(); const o = api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k", lines }); return handle(() => api.confirmOrder(owner, confirmReq(o.id, { expectedVersion: 99 })), guard); } },
  { label: "IDEMPOTENCY_CONFLICT", method: "post", path: CONFIRM, status: 409, run: () => { const { api, owner } = setup(); const o = api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k", lines }); api.confirmOrder(owner, confirmReq(o.id)); return handle(() => api.confirmOrder(owner, confirmReq(o.id, { expectedVersion: 2 })), guard); } },
  { label: "재확정(BUSINESS_INVARIANT)", method: "post", path: CONFIRM, status: 422, run: () => { const { api, owner } = setup(); const o = api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k", lines }); api.confirmOrder(owner, confirmReq(o.id)); return handle(() => api.confirmOrder(owner, confirmReq(o.id, { expectedVersion: 2, idempotencyKey: "c-2" })), guard); } },
  { label: "저장소 장애", method: "post", path: CONFIRM, status: 500, run: () => handle(() => brokenApi().confirmOrder({ userId: "owner-a" }, confirmReq("x")), guard) },
  // HTTP 계층 오류(DB 없이 판정): 허용되지 않는 메서드, 잘못된 Content-Type, 알 수 없는 쿼리
  { label: "허용되지 않는 메서드", method: "get", path: O, status: 405, run: wrongMethod(O) },
  { label: "허용되지 않는 메서드", method: "post", path: O, status: 405, run: wrongMethod(O) },
  { label: "Content-Type이 JSON이 아님", method: "post", path: O, status: 415, run: notJson(O) },
  { label: "알 수 없는 쿼리", method: "get", path: OID, status: 400, run: () => callHttp({ method: "GET", path: OID, query: "__unknown__=1" }) },
  { label: "허용되지 않는 메서드", method: "get", path: OID, status: 405, run: wrongMethod(OID) },
  { label: "허용되지 않는 메서드", method: "post", path: CONFIRM, status: 405, run: wrongMethod(CONFIRM) },
  { label: "Content-Type이 JSON이 아님", method: "post", path: CONFIRM, status: 415, run: notJson(CONFIRM) },
];

describe("오류 응답도 스키마를 만족하고, 스펙이 선언한 모든 오류 응답을 검증한다", () => {
  it.each(scenarios.map((s) => [`${s.method.toUpperCase()} ${s.path} → ${s.status} (${s.label})`, s] as const))(
    "%s",
    async (_name, s) => {
      const response = await s.run();

      expect(response.status).toBe(s.status);
      expectConforms(s.path, s.method, response);
      // 어떤 경우에도 내부 원본 정보가 응답에 새면 안 된다
      expect(JSON.stringify(response.body)).not.toMatch(/hunter2|db down/);
    },
  );

  it("스펙이 선언한 (엔드포인트, 오류 상태) 조합과 시나리오가 정확히 일치한다 (스펙·테스트 드리프트 방지)", () => {
    const declared = new Set<string>();
    for (const [path, item] of Object.entries<Json>(spec.paths)) {
      for (const [method, op] of Object.entries<Json>(item)) {
        if (!["get", "post"].includes(method)) continue;
        for (const status of Object.keys(op.responses)) {
          if (!SUCCESS.has(status)) declared.add(`${method} ${path} ${status}`);
        }
      }
    }
    const covered = new Set(scenarios.map((s) => `${s.method} ${s.path} ${s.status}`));

    expect([...covered].sort()).toEqual([...declared].sort());
  });
});

describe("실제 응답이 openapi/ordering.yaml의 스키마를 만족한다", () => {
  it("성공: 생성 201, 상세 200, 확정 200, 목록 200", () => {
    const { api, owner } = setup();
    const created = handle(
      () => api.createOrder(owner, { tenantId: "tenant-a", idempotencyKey: "k-1", lines }),
      { successStatus: 201 },
    );
    expectConforms(`${BASE}/orders`, "post", created);
    const orderId = (created.body as Json).data.id as string;

    expectConforms(
      `${BASE}/orders/{orderId}`,
      "get",
      handle(() => api.getOrder(owner, { tenantId: "tenant-a", orderId })),
    );
    expectConforms(
      `${BASE}/orders/{orderId}/confirm`,
      "post",
      handle(() =>
        api.confirmOrder(owner, {
          tenantId: "tenant-a",
          orderId,
          expectedVersion: 1,
          idempotencyKey: "c-1",
        }),
      ),
    );
    // 확정 후 상세에는 displayNumber·totalKrw가 있어야 한다
    expectConforms(
      `${BASE}/orders/{orderId}`,
      "get",
      handle(() => api.getOrder(owner, { tenantId: "tenant-a", orderId })),
    );
    expectConforms(
      `${BASE}/orders`,
      "get",
      handle(() => api.listOrders(owner, { tenantId: "tenant-a", limit: 1 })),
    );
  });
});
