import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";
import { loadOperations, MISSING, sampleBody, specKey, type Json } from "../helpers/httpContract";

/**
 * 요청 스키마와 서버 입력 검증의 일치를 모든 서점 범위 POST 경로의 모든 최상위 필드에서 확인한다.
 * 기준 본문(명세에서 만든 최소 본문, 대상이 없어 404까지 가는 것)에서 필드 하나씩을 경계값으로 바꾸거나 빼서,
 * 스키마가 거부하는 입력은 서버도 400이어야 하고 스키마가 받아들이는 입력은 서버가 400이 아니어야 한다. 서버의 5xx는 별도로 센다.
 */
const SECRET = "request-agreement-secret-0123456789abcdef0";
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
const send = async (template: string, body: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const path = `/v1/tenants/${T}${template}`.replace(/\{code\}/g, "missing-code").replace(/\{[^}]+\}/g, MISSING);
  const response = await app({ method: "POST", path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}`, "idempotency-key": `agree-${++seq}`, "content-type": "application/json" }, rawBody: JSON.stringify(body) });
  return { status: response.status, message: (response.body as any)?.error?.message as string | undefined };
};

const OMIT = Symbol("omit");
/** 필드의 스키마에서 경계값을 만든다 */
function mutations(name: string, schema: Json): { label: string; value: unknown }[] {
  const out: { label: string; value: unknown }[] = [];
  const add = (label: string, value: unknown) => out.push({ label, value });
  if (schema.enum) add("없는 enum 값", "BOGUS");
  switch (schema.type) {
    case "integer":
      for (const v of [0, -1, 1.5, "1", null]) add(`정수 자리에 ${JSON.stringify(v)}`, v);
      break;
    case "boolean":
      for (const v of ["true", 1, null]) add(`불리언 자리에 ${JSON.stringify(v)}`, v);
      break;
    case "array":
      add("배열 자리에 문자열", "x");
      add("빈 배열", []);
      break;
    case "object":
      add("객체 자리에 문자열", "x");
      break;
    case "string":
      add("빈 문자열", "");
      add("문자열 자리에 숫자", 123);
      add("문자열 자리에 null", null);
      if (/Krw$/.test(name)) for (const v of ["0", "-5", "1.5", "abc", "012", "1".repeat(16)]) add(`금액 ${JSON.stringify(v).slice(0, 12)}`, v);
      if (schema.format === "date-time") for (const v of ["not-a-date", "2026-03-04", "2999-01-01T00:00:00.000Z"]) add(`시각 ${JSON.stringify(v)}`, v);
      if (schema.format === "date") for (const v of ["2026-13-45", "not-a-date"]) add(`날짜 ${JSON.stringify(v)}`, v);
      if (schema.format === "uuid") add("uuid 아님", "not-a-uuid");
      break;
  }
  return out;
}

describe("요청 스키마와 서버 입력 검증의 일치 (모든 경로·모든 최상위 필드)", () => {
  it("스키마가 거부하는 입력은 서버도 400이고, 스키마가 받아들이는 입력은 서버가 400이 아니며, 서버는 5xx를 내지 않는다", async () => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)));
    ajv.addFormat("date", (v) => /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v)));
    ajv.addFormat("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));

    /** 서버가 대상 조회(404)를 입력 검증보다 먼저 하는 경로에서는, 대상이 없으면 검증까지 가지 못해 거부 입력을 비교할 수 없다 */
    let inconclusive = 0;
    /** JSON 스키마로 표현할 수 없는 서버 규칙: "현재보다 이후일 수 없다" */
    let futureTimestamps = 0;
    const groups = new Map<string, { count: number; example: string }>();
    const bump = (key: string, example: string) => {
      const g = groups.get(key) ?? { count: 0, example };
      g.count++;
      groups.set(key, g);
    };
    let skipped = 0;
    let compared = 0;

    for (const r of app.routes.filter((x) => x.scope === "tenant" && x.method === "POST")) {
      const key = specKey(r);
      const op = ops.get(key)!;
      const schema = op.requestBody?.content?.["application/json"]?.schema as Json | undefined;
      if (!schema?.properties) continue;
      const baseline = JSON.parse(sampleBody(op)) as Record<string, unknown>;
      if ((await send(r.template, baseline)).status === 400) {
        skipped++; // 기준 본문이 이미 입력 검증을 통과하지 못하는 경로는 비교할 수 없다
        continue;
      }
      for (const [name, propSchema] of Object.entries<Json>(schema.properties)) {
        const cases: { label: string; value: unknown }[] = mutations(name, propSchema);
        if ((schema.required ?? []).includes(name)) cases.push({ label: "필수 필드 누락", value: OMIT });
        for (const c of cases) {
          const body = { ...baseline };
          if (c.value === OMIT) delete body[name];
          else body[name] = c.value;
          const schemaAccepts = ajv.validate(schema, body) as boolean;
          const { status, message } = await send(r.template, body);
          compared++;
          const where = `${key.replace("POST /v1/tenants/{tenantId}", "")} .${name}`;
          if (status >= 500) bump(`서버 ${status}|${c.label}`, `${where} (${message ?? ""})`);
          else if (schemaAccepts && status === 400 && c.label.includes("2999-")) futureTimestamps++; // 미래 시각은 스키마로 표현할 수 없다
          else if (schemaAccepts && status === 400) bump(`스키마 허용·서버 400|${c.label}`, `${where}: ${message}`);
          else if (!schemaAccepts && status === 404) inconclusive++; // 대상 조회가 검증보다 먼저라 판단할 수 없다
          else if (!schemaAccepts && status !== 400) bump(`스키마 거부·서버 ${status}|${c.label}`, where);
        }
      }
    }
    const summary = [...groups.entries()].sort().map(([k, g]) => `${String(g.count).padStart(3)}건 ${k}  예) ${g.example}`);
    expect({ compared, skipped, disagreements: summary }).toMatchObject({ disagreements: [] });
    // 비교 범위가 조용히 줄어들지 않도록 하한을 둔다(2026-11-26 기준 984건 비교, 4개 경로 제외)
    expect(compared).toBeGreaterThan(900);
    expect(skipped).toBeLessThanOrEqual(4);
    // 예외 두 부류가 늘어나면 새 불일치가 숨는 것이다
    expect(inconclusive).toBeGreaterThan(0);
    expect(futureTimestamps).toBeGreaterThan(0);
  }, 300_000);
});
