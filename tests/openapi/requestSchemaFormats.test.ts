import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";
import { loadOperations, type Json } from "../helpers/httpContract";

/**
 * 요청 스키마의 형식 제약이 서버의 입력 검증과 같은지 확인한다. 같은 입력에 대해 스키마가 거부하면 서버도 400(입력 검증 실패)이어야 하고,
 * 스키마가 받아들이면 서버가 400이 아니어야 한다(다른 이유의 409·422는 상관없다). 스키마가 도메인 형식을 놓치면 클라이언트가 스키마만 믿고
 * 보낸 요청이 서버에서 거부된다.
 */
const SECRET = "request-format-secret-0123456789abcdef0123";
const T = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";
const PAST = "2026-03-04T06:00:00.000Z";
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

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
const post = async (path: string, body: unknown) => {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const response = await app({ method: "POST", path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}`, "idempotency-key": `fmt-${++seq}`, "content-type": "application/json" }, rawBody: JSON.stringify(body) });
  return response.status;
};

type Case = { label: string; body: Record<string, unknown> };
async function agree(route: string, path: string, cases: Case[]) {
  const ops = await loadOperations();
  const schema = ops.get(`POST /v1/tenants/{tenantId}${route}`)!.requestBody.content["application/json"].schema as Json;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat("date-time", (v) => !Number.isNaN(Date.parse(v)));
  ajv.addFormat("date", (v) => /^\d{4}-\d\d-\d\d$/.test(v));
  ajv.addFormat("uuid", /^[0-9a-f-]{36}$/i);
  const disagreements: string[] = [];
  for (const c of cases) {
    const schemaAccepts = ajv.validate(schema, c.body) as boolean;
    const status = await post(path, c.body);
    const serverRejects = status === 400;
    if (schemaAccepts === serverRejects) disagreements.push(`${c.label}: 스키마는 ${schemaAccepts ? "허용" : "거부"}, 서버는 ${serverRejects ? "400 거부" : `${status}`}`);
  }
  return disagreements;
}

describe("요청 스키마의 형식 제약이 서버의 입력 검증과 같다", () => {
  it("문구 템플릿 key: 대문자로 시작하는 대문자·숫자·밑줄, 최대 64자", async () => {
    const withKey = (key: unknown): Case => ({ label: `key(${String(key).length}자)=${JSON.stringify(key).slice(0, 14)}`, body: { key, body: "{{storeName}}입니다", expectedVersion: 0, publishedAt: PAST } });
    expect(await agree("/message-templates", "/message-templates", [
      withKey("ORDER_READY"), withKey("A"), withKey("A1_B2"), withKey("A".repeat(64)),
      withKey("order_ready"), withKey(""), withKey("1ORDER"), withKey("ORDER-READY"), withKey("A".repeat(65)), withKey("_ORDER"),
    ])).toEqual([]);
  });

  it("직원 초대 email: 앞뒤 공백을 뺀 값이 '이름@도메인.최상위' 형식", async () => {
    const withEmail = (email: unknown): Case => ({ label: `email=${JSON.stringify(email)}`, body: { email, expiresAt: days(7) } });
    expect(await agree("/staff-invitations", "/staff-invitations", [
      withEmail("a@b.co"), withEmail("  A@B.CO  "), withEmail("first.last+tag@sub.example.com"),
      withEmail("not-an-email"), withEmail("a@b"), withEmail("a b@c.d"), withEmail("@b.c"), withEmail("a@@b.c"), withEmail(""),
    ])).toEqual([]);
  });

  it("도서 등록: 수기 등록은 reason, YES24 등록은 externalId·fetchedAt이 필수이고 listPriceKrw는 양의 정수 문자열", async () => {
    const base = { title: "형식 책", listPriceKrw: "12000", registeredAt: PAST };
    const book = (label: string, extra: Record<string, unknown>, price = "12000"): Case => ({ label, body: { ...base, listPriceKrw: price, ...extra } });
    expect(await agree("/books", "/books", [
      book("수기 + reason", { source: "MANUAL", reason: "수기 등록" }),
      book("YES24 + externalId + fetchedAt", { source: "YES24", externalId: "Y-1", fetchedAt: PAST }),
      book("수기, reason 없음", { source: "MANUAL" }),
      book("수기, reason 빈 문자열", { source: "MANUAL", reason: "" }),
      book("YES24, externalId 없음", { source: "YES24", fetchedAt: PAST }),
      book("YES24, fetchedAt 없음", { source: "YES24", externalId: "Y-2" }),
      book("가격 0", { source: "MANUAL", reason: "r" }, "0"),
      book("가격 음수", { source: "MANUAL", reason: "r" }, "-1000"),
      book("가격 소수", { source: "MANUAL", reason: "r" }, "1.5"),
      book("가격 앞자리 0", { source: "MANUAL", reason: "r" }, "012"),
      book("가격 문자", { source: "MANUAL", reason: "r" }, "abc"),
    ])).toEqual([]);
  });
});
