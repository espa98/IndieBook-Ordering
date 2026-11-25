import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";
import { loadOperations, MISSING, sampleBody, specKey } from "../helpers/httpContract";

/**
 * DB가 필요한 공통 오류(403 비멤버, 404 없는 대상)를 모든 서점 범위 경로에서 실제로 일으켜
 * 상태·명세 선언·`ErrorBody`를 확인한다. 경로별 특수한 409·422는 여기서 다루지 않는다.
 */
const SECRET = "error-contract-db-secret-0123456789abcdef";
const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";

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
const request = (r: { method: "GET" | "POST"; template: string }, sub: string, idFill: string, body = "{}") => ({
  method: r.method,
  path: `/v1/tenants/${T_A}${r.template}`.replace(/\{code\}/g, "missing-code").replace(/\{[^}]+\}/g, idFill),
  query: new URLSearchParams(),
  headers: { authorization: `Bearer ${token(sub)}`, ...(r.method === "POST" ? { "idempotency-key": "k-1", "content-type": "application/json" } : {}) } as Record<string, string>,
  rawBody: r.method === "POST" ? body : undefined,
});

async function check(routes: ReturnType<typeof tenantRoutes>, sub: string, idFill: string, expected: number) {
  const ops = await loadOperations();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const problems: string[] = [];
  for (const r of routes) {
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

describe("오류 응답 계약(DB): 모든 서점 범위 경로의 공통 오류", () => {
  it("서점의 멤버가 아닌 사용자의 요청은 모든 경로에서 403이고, 명세가 선언하며, 본문이 ErrorBody를 만족한다", async () => {
    expect(await check(tenantRoutes(), STRANGER, MISSING, 403)).toEqual([]);
  });

  it("멤버가 존재하지 않는 대상(UUID 형식은 맞음)을 가리키면 모든 경로에서 404이고, 명세가 선언하며, 본문이 ErrorBody를 만족한다", async () => {
    const withTarget = tenantRoutes().filter((r) => /\{(?!code\})[^}]+\}/.test(r.template));
    expect(withTarget.length).toBeGreaterThan(40);
    // 읽기(GET)와 쓰기(POST)를 나눠 확인한다. 쓰기가 실패해도 읽기 결과는 영향받지 않는다
    expect(await check(withTarget.filter((r) => r.method === "GET"), OWNER, MISSING, 404)).toEqual([]);
    expect(await check(withTarget.filter((r) => r.method === "POST"), OWNER, MISSING, 404)).toEqual([]);
  });
});
