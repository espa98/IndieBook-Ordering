import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../../server/pool";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 쿼리 시간 제한(T4): 다른 세션이 잠근 행을 기다리는 요청은 영원히 매달리면 안 된다(연결을 쥔 채 풀이 말라 서버 전체가 멎는다).
 * 운영 풀은 `createDatabasePool`로 만들며, 제한을 넘기면 요청은 500으로 끝나고 아무것도 남기지 않으며 연결은 풀로 돌아온다.
 */
const SECRET = "timeout-secret-0123456789abcdef0123456789";
const T = "aaaaaaaa-0000-4000-8000-000000000005";
const OWNER = "11111111-0000-4000-8000-000000000005";
const TIMEOUT_MS = 800;
const POOL_MAX = 2;

let db: IsolatedPostgres;
let pool: ReturnType<typeof createDatabasePool>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await c.end();
  pool = createDatabasePool({ databaseUrl: `postgres://postgres:isolated-test-only@127.0.0.1:${db.port}/bookflow_test`, statementTimeoutMs: TIMEOUT_MS, max: POOL_MAX });
  app = createApp({ pool, jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await pool?.end();
  await db?.stop();
}, 60_000);

let seq = 0;
async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "POST") headers["idempotency-key"] = `to-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

describe("DB 쿼리 시간 제한", () => {
  it("잠금을 기다리다 제한을 넘기면 500으로 끝나고 아무것도 남기지 않으며, 풀 크기보다 많은 요청이 몰려도 연결이 새지 않고 잠금이 풀리면 정상 처리된다", async () => {
    const book = (await call("POST", "/books", { source: "MANUAL", title: "타임아웃 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: "2026-03-04T06:00:00.000Z" })).body.data;
    const order = (await call("POST", "/orders", { lines: [{ bookId: book.id, quantity: 1, unitPriceKrw: "10000" }] })).body.data;

    const locker = await db.connect();
    await locker.query("begin");
    await locker.query("select 1 from public.ordering_orders where id = $1 for update", [order.id]);
    try {
      const started = Date.now();
      // 풀(2)보다 많은 3건이 동시에 같은 잠긴 주문을 확정하려 한다
      const results = await Promise.all([1, 2, 3].map(() => call("POST", `/orders/${order.id}/confirm`, { expectedVersion: 1 })));
      const elapsed = Date.now() - started;
      expect(results.map((r) => r.status)).toEqual([500, 500, 500]);
      expect(elapsed, "제한(0.8초) 근처에서 끝나야 한다: 순차로 밀려도 3×제한 + 여유").toBeLessThan(TIMEOUT_MS * 3 + 4_000);
    } finally {
      await locker.query("rollback");
      await locker.end();
    }

    const check = await db.connect();
    expect((await check.query("select status, version from public.ordering_orders where id = $1", [order.id])).rows[0]).toMatchObject({ status: "DRAFT", version: "1" });
    await check.end();

    const confirmed = await call("POST", `/orders/${order.id}/confirm`, { expectedVersion: 1 });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(pool.totalCount - pool.idleCount, "빌려 간 채 돌아오지 않은 연결이 없다").toBe(0);
  }, 60_000);
});
