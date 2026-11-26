import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createYes24Provider } from "../../src/catalog/yes24Provider";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * GET /book-search, GET /integrations/yes24 (B-01·S-08): 서버가 실제 YES24 어댑터(HTTP)로 상류를 호출하고, 결과를 선택해 도서로 등록하는 흐름과
 * 장애 시 수기 등록으로 대체되는 흐름을 끝까지 확인한다. 상류는 로컬 흉내 서버다(실제 YES24 API가 아니다).
 */
const SECRET = "book-search-secret-0123456789abcdef012";
const T = "aaaaaaaa-0000-4000-8000-0000000000d3";
const OWNER = "11111111-0000-4000-8000-0000000000d3";
const STAFF = "11111111-0000-4000-8000-0000000000d4";
const EX_STAFF = "11111111-0000-4000-8000-0000000000d5";
const STRANGER = "99999999-0000-4000-8000-0000000000d3";
const PAST = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
let upstream: Server;
let upstreamUrl = "";
let upstreamUp = true;
let withProvider: ReturnType<typeof createApp>;
let withoutProvider: ReturnType<typeof createApp>;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (!upstreamUp) {
      res.writeHead(502);
      res.end("bad gateway secret-upstream");
      return;
    }
    const url = new URL(req.url ?? "", "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [{ id: "Y24-1", title: `${url.searchParams.get("q")} 시집`, authors: ["박서점"], isbn: "978-89-6090-123-4", listPriceKrw: 12000, publisher: "책방출판", publishedOn: "2025-03-01" }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/search`;

  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  await c.end();
  const jwt = { keys: [{ kid: "k1", alg: "HS256" as const, key: SECRET }], audience: "authenticated" };
  withProvider = createApp({ pool: db.pool(), jwt, bookSearch: createYes24Provider({ url: upstreamUrl, apiKey: "secret-key-123", timeoutMs: 800 }) });
  withoutProvider = createApp({ pool: db.pool(), jwt });
}, 180_000);
afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await db?.stop();
}, 60_000);

let seq = 0;
function call(app: ReturnType<typeof createApp>, method: "GET" | "POST", path: string, sub: string | undefined, query = "", body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") headers["idempotency-key"] = `bs-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(query), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("YES24 도서 검색 HTTP (B-01)", () => {
  it("직원이 제목으로 검색하고, 결과를 선택해 YES24 출처로 등록한 뒤 같은 ISBN을 다시 검색하면 이미 등록된 도서로 표시된다", async () => {
    const found = await call(withProvider, "GET", "/book-search", STAFF, "type=TITLE&q=%EC%9A%B4%EC%98%81&limit=5");
    expect(found.status).toBe(200);
    expect(found.body.data).toMatchObject({ source: "YES24", fetchedAt: expect.any(String) });
    const item = found.body.data.items[0];
    expect(item).toMatchObject({ id: "Y24-1", title: "운영 시집", isbn: "9788960901234", listPriceKrw: "12000" });
    expect(item.existingBookId).toBeUndefined();

    // 선택 → 도서 등록(출처 YES24, 외부 ID·조회 시각 저장). 판매가는 직원이 입력한다
    const registered = await call(withProvider, "POST", "/books", STAFF, "", {
      source: "YES24", title: item.title, authors: item.authors, isbn: item.isbn, externalId: item.id, fetchedAt: found.body.data.fetchedAt, listPriceKrw: "13000", registeredAt: PAST,
    });
    expect(registered.status).toBe(201);
    expect(registered.body.data).toMatchObject({ source: "YES24", externalId: "Y24-1", isbn: "9788960901234" });

    const again = await call(withProvider, "GET", "/book-search", OWNER, "type=ISBN&q=978-89-6090-123-4");
    expect(again.body.data.items[0].existingBookId).toBe(registered.body.data.id);
  });

  it("상류 장애·미설정은 503 SERVICE_UNAVAILABLE이고(키·상류 내용 노출 없음), 그때도 수기 등록은 된다. 연동 상태가 마지막 결과를 알려 준다", async () => {
    expect((await call(withoutProvider, "GET", "/book-search", OWNER, "type=TITLE&q=x")).body).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable" } });
    expect((await call(withoutProvider, "GET", "/integrations/yes24", OWNER)).body.data).toEqual({ provider: "YES24", configured: false });

    upstreamUp = false;
    const down = await call(withProvider, "GET", "/book-search", STAFF, "type=TITLE&q=x");
    upstreamUp = true;
    expect(down.status).toBe(503);
    expect(JSON.stringify(down.body)).not.toMatch(/secret|127\.0\.0\.1|bad gateway/);
    expect((await call(withProvider, "GET", "/integrations/yes24", STAFF)).body.data).toMatchObject({ provider: "YES24", configured: true, lastSearch: { ok: false } });

    const manual = await call(withProvider, "POST", "/books", STAFF, "", { source: "MANUAL", title: "장애 중 수기 등록", listPriceKrw: "9000", reason: "YES24 장애", registeredAt: PAST });
    expect(manual.status).toBe(201);
    expect(manual.body.data.source).toBe("MANUAL");
    expect((await call(withProvider, "GET", "/book-search", STAFF, "type=TITLE&q=x")).status).toBe(200); // 복구되면 다시 된다
    expect((await call(withProvider, "GET", "/integrations/yes24", STAFF)).body.data.lastSearch.ok).toBe(true);
  });

  it("비멤버·비활성은 403, 인증 없음은 401, 잘못된 type·검색어·limit·알 수 없는 쿼리는 400, POST는 405", async () => {
    for (const sub of [STRANGER, EX_STAFF]) {
      expect((await call(withProvider, "GET", "/book-search", sub, "type=TITLE&q=x")).status, sub).toBe(403);
      expect((await call(withProvider, "GET", "/integrations/yes24", sub)).status, sub).toBe(403);
    }
    expect((await call(withProvider, "GET", "/book-search", undefined, "type=TITLE&q=x")).status).toBe(401);
    for (const query of ["", "type=TITLE", "type=ALL&q=x", "type=TITLE&q=", "type=ISBN&q=123", `type=TITLE&q=${"가".repeat(61)}`, "type=TITLE&q=x&limit=0", "type=TITLE&q=x&limit=21", "type=TITLE&q=x&limit=abc", "type=TITLE&q=x&x=1"]) {
      expect((await call(withProvider, "GET", "/book-search", OWNER, query)).status, query).toBe(400);
    }
    expect((await call(withProvider, "POST", "/book-search", OWNER, "", {})).status).toBe(405);
  });
});
