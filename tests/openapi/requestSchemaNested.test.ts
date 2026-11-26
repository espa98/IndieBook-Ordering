import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";
import { loadOperations, MISSING, mutations, OMIT, sampleBody, specKey, type Json } from "../helpers/httpContract";

/**
 * `requestSchemaAgreement`가 최상위 필드만 비교하는 한계를 메운다. 요청 스키마의 **중첩 필드**(배열 원소의 속성, 객체의 속성)와
 * **배열 제약**(빈 배열, 중복 원소)을 같은 방식으로 변이해, 스키마가 거부하는 입력은 서버도 400이고 스키마가 받아들이는 입력은
 * 서버가 400이 아니며 서버가 5xx를 내지 않는지 확인한다.
 */
const SECRET = "request-nested-secret-0123456789abcdef012345";
const T = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";

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

let seq = 0;
const send = async (template: string, body: unknown) => {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const path = `/v1/tenants/${T}${template}`.replace(/\{code\}/g, "missing-code").replace(/\{[^}]+\}/g, MISSING);
  const response = await app({ method: "POST", path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}`, "idempotency-key": `nest-${++seq}`, "content-type": "application/json" }, rawBody: JSON.stringify(body) });
  return { status: response.status, message: (response.body as any)?.error?.message as string | undefined, data: (response.body as any)?.data };
};

type Leaf = { path: (string | number)[]; schema: Json; required: boolean; parent: Json };
/** 스키마를 재귀로 훑어 최상위가 아닌 중첩 필드(배열 원소의 속성, 객체의 속성)와 배열 자체를 모은다 */
function nested(schema: Json, path: (string | number)[] = [], out: Leaf[] = [], parent: Json = {}): Leaf[] {
  if (schema.type === "array" && schema.items) {
    if (path.length > 0) out.push({ path, schema, required: true, parent });
    nested(schema.items, [...path, 0], out, schema);
  }
  if (schema.type === "object" && schema.properties) {
    for (const [name, prop] of Object.entries<Json>(schema.properties)) {
      const p = [...path, name];
      const required = (schema.required ?? []).includes(name);
      if (path.length > 0) out.push({ path: p, schema: prop, required, parent: schema });
      nested(prop, p, out, schema);
    }
  }
  return out;
}
const setAt = (root: any, path: (string | number)[], value: unknown) => {
  let node = root;
  for (const key of path.slice(0, -1)) node = node?.[key];
  if (node === undefined || node === null) return false;
  if (value === OMIT) delete node[path[path.length - 1]!];
  else node[path[path.length - 1]!] = value;
  return true;
};
const label = (path: (string | number)[]) => path.map((k) => (typeof k === "number" ? "[]" : `.${k}`)).join("").replace(/^\./, "");

describe("요청 스키마와 서버 입력 검증의 일치 (중첩 필드·배열 제약)", () => {
  it("중첩 필드의 거부 입력은 서버도 400이고, 스키마가 받아들이는 입력은 서버가 400이 아니며, 서버는 5xx를 내지 않는다", async () => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)));
    ajv.addFormat("date", (v) => /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v)));
    ajv.addFormat("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));

    const groups = new Map<string, { count: number; example: string }>();
    const bump = (key: string, example: string) => {
      const g = groups.get(key) ?? { count: 0, example };
      g.count++;
      groups.set(key, g);
    };
    let compared = 0;
    let inconclusive = 0;
    let futureTimestamps = 0;
    let skipped = 0;
    const leafCount = new Map<string, number>();

    // 최소 본문이 서버 검증을 통과하지 못하는 경로의 기준 본문: 주문 생성은 카탈로그에 있는 도서가, 도서 등록은 수기 사유가 필요하다
    const book = await send("/books", { source: "MANUAL", title: "중첩 비교용 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" });
    expect(book.status, "기준 도서 등록").toBe(201);
    const BASELINES: Record<string, Record<string, unknown>> = {
      "POST /v1/tenants/{tenantId}/orders": { lines: [{ bookId: book.data.id, quantity: 1, unitPriceKrw: "10000" }] },
      "POST /v1/tenants/{tenantId}/books": { source: "MANUAL", title: "기준 책", authors: ["가나다"], listPriceKrw: "10000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" },
    };

    for (const r of app.routes.filter((x) => x.scope === "tenant" && x.method === "POST")) {
      const key = specKey(r);
      const op = ops.get(key)!;
      const schema = op.requestBody?.content?.["application/json"]?.schema as Json | undefined;
      if (!schema?.properties) continue;
      const leaves = nested(schema);
      if (leaves.length === 0) continue;
      const baseline = (BASELINES[key] ?? JSON.parse(sampleBody(op))) as Record<string, unknown>;
      if ((await send(r.template, baseline)).status === 400) {
        skipped++;
        continue;
      }
      leafCount.set(key.replace("POST /v1/tenants/{tenantId}", ""), leaves.length);
      for (const leaf of leaves) {
        const name = String(leaf.path.filter((k) => typeof k === "string").at(-1) ?? "");
        const cases = mutations(name, leaf.schema);
        if (leaf.required) cases.push({ label: "필수 필드 누락", value: OMIT });
        if (leaf.schema.type === "array" && leaf.schema.items?.type === "string") cases.push({ label: "배열의 중복 원소", value: ["x", "x"] });
        for (const c of cases) {
          const body = JSON.parse(JSON.stringify(baseline));
          if (!setAt(body, leaf.path, c.value)) continue; // 기준 본문에 그 경로가 없다(선택 필드)
          const schemaAccepts = ajv.validate(schema, body) as boolean;
          const { status, message } = await send(r.template, body);
          compared++;
          const where = `${key.replace("POST /v1/tenants/{tenantId}", "")} ${label(leaf.path)}`;
          if (status >= 500) bump(`서버 ${status}|${c.label}`, `${where} (${message ?? ""})`);
          else if (schemaAccepts && status === 400 && c.label.includes("2999-")) futureTimestamps++;
          else if (schemaAccepts && status === 400) bump(`스키마 허용·서버 400|${c.label}`, `${where}: ${message}`);
          else if (!schemaAccepts && status === 404) inconclusive++;
          else if (!schemaAccepts && status !== 400) bump(`스키마 거부·서버 ${status}|${c.label}`, where);
        }
      }
    }
    const summary = [...groups.entries()].sort().map(([k, g]) => `${String(g.count).padStart(3)}건 ${k}  예) ${g.example}`);
    expect({ compared, skipped, routes: leafCount.size, inconclusive, futureTimestamps, disagreements: summary }).toMatchObject({ disagreements: [] });
    // 비교 범위가 조용히 줄어들지 않도록 비교된 경로를 그대로 고정한다(2026-11-26 기준 5개 경로, 69건).
    // 요청 스키마에 중첩 구조가 있는 경로 7개를 모두 비교한다. 최소 본문이 서버 검증을 통과하지 못하는 `POST /orders`(`lines[]`: 도서가 카탈로그에
    // 있어야 함)와 `POST /books`(`authors[]`: 수기 등록의 조건부 필수 `reason`)는 손으로 만든 기준 본문을 쓴다.
    expect([...leafCount.keys()].sort()).toEqual([
      "/books",
      "/books/{bookId}/updates",
      "/orders",
      "/orders/{orderId}/fulfillments",
      "/orders/{orderId}/fulfillments/{fulfillmentId}/corrections",
      "/purchase-orders",
      "/suppliers/{code}/updates",
    ]);
    expect(compared).toBeGreaterThan(60);
    expect(skipped).toBe(0); // 기준 본문이 400인 경로는 손으로 만든 기준 본문을 쓴다
    // 서버가 대상 조회(404)를 입력 검증보다 먼저 해서 거부 입력을 비교하지 못한 건수. 2026-11-26에 도서 수정(`changes`)과 수령 정정(`restorations[]`)의
    // 검증을 조회보다 앞으로 옮겨 0이 되었다(전에는 30건). 다시 생기면 그 경로의 거부 입력이 서버에서 400인지 확인되지 않은 것이다
    expect(inconclusive).toBe(0);
  }, 300_000);
});
