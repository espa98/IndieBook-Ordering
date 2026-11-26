import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 저장 도중 실패 주입(T4) 2단계: atomicRollback.test.ts는 감사 삽입(커밋 직전)에서만 실패시켰다.
 * 여기서는 명령이 실행하는 k번째 쓰기(어느 ordering_* 테이블이든, 감사 제외)에서 실패시킨다.
 * k를 1부터 올리며, 명령이 더 이상 실패하지 않을 때까지(= 쓰기 수를 넘길 때까지) 매번 DB 전체가 그대로인지 확인한다.
 */
const SECRET = "midstep-rollback-secret-0123456789abcdef0123";
const T = "aaaaaaaa-0000-4000-8000-000000000002";
const OWNER = "11111111-0000-4000-8000-000000000002";
const PAST = "2026-03-04T06:00:00.000Z";

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

async function snapshot(): Promise<Record<string, string>> {
  const c = await db.connect();
  try {
    const tables = (await c.query("select tablename from pg_tables where schemaname = 'public' and tablename like 'ordering\_%' order by tablename")).rows.map((r) => r.tablename as string);
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await c.query(`select count(*)::int as n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from public.${t} x`);
      out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  } finally {
    await c.end();
  }
}
const diff = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((t) => a[t] !== b[t]);

/** 감사 로그를 뺀 모든 ordering_* 테이블의 쓰기 중 k번째에서 실패한다 (k=0이면 해제) */
async function failOnKthWrite(k: number) {
  const c = await db.connect();
  try {
    const tables = (await c.query("select tablename from pg_tables where schemaname = 'public' and tablename like 'ordering\_%' and tablename <> 'ordering_audit_log'")).rows.map((r) => r.tablename as string);
    for (const t of tables) await c.query(`drop trigger if exists __kth_fault on public.${t}`);
    await c.query(`drop table if exists public.__fault_state`);
    if (k === 0) return;
    await c.query(`create table public.__fault_state (n int not null, target int not null)`);
    await c.query(`insert into public.__fault_state values (0, $1)`, [k]);
    await c.query(`create or replace function public.__kth_fault() returns trigger language plpgsql security definer as $$ declare cur int; tgt int; begin update public.__fault_state set n = n + 1 returning n, target into cur, tgt; if cur = tgt then raise exception 'injected failure at write %', cur using errcode = 'XX000'; end if; return coalesce(new, old); end $$`);
    for (const t of tables) await c.query(`create trigger __kth_fault before insert or update or delete on public.${t} for each row execute function public.__kth_fault()`);
  } finally {
    await c.end();
  }
}

let seq = 0;
async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "POST") headers["idempotency-key"] = `mid-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

/** k번째 쓰기 실패를 k=1,2,...로 반복한다. 500이 아니게 되면 쓰기 수를 넘긴 것이므로 실제 실행으로 보고 반환한다 */
async function writeFailingAtEachStep(label: string, path: string, body: unknown, status: number) {
  let steps = 0;
  for (let k = 1; k <= 40; k++) {
    const before = await snapshot();
    await failOnKthWrite(k);
    const r = await call("POST", path, body);
    await failOnKthWrite(0);
    if (r.status !== 500) {
      expect(r.status, `${label}: ${k}번째 쓰기 없이 끝난 실행 ${JSON.stringify(r.body)}`).toBe(status);
      expect(steps, `${label}: 쓰기가 한 번도 실패하지 않았다`).toBeGreaterThan(0);
      return { data: r.body.data, steps };
    }
    expect(diff(before, await snapshot()), `${label}: ${k}번째 쓰기 실패 뒤 변경된 테이블`).toEqual([]);
    steps = k;
  }
  throw new Error(`${label}: 쓰기가 40번을 넘는다`);
}

describe("저장 도중 실패 주입: 명령 중간의 k번째 쓰기에서 실패해도 아무것도 남지 않는다", () => {
  it("도서 등록·주문 생성·주문 확정·결제 입력의 모든 쓰기 단계", async () => {
    const book = (await writeFailingAtEachStep("도서 등록", "/books", { source: "MANUAL", title: "중간 실패 책", listPriceKrw: "10000", reason: "수기 등록", registeredAt: PAST }, 201)).data;
    const created = await writeFailingAtEachStep("주문 생성", "/orders", { lines: [{ bookId: book.id, quantity: 2, unitPriceKrw: "10000" }] }, 201);
    expect(created.steps).toBeGreaterThanOrEqual(2);
    const confirmed = await writeFailingAtEachStep("주문 확정", `/orders/${created.data.id}/confirm`, { expectedVersion: 1 }, 200);
    expect(confirmed.steps).toBeGreaterThanOrEqual(2);
    await writeFailingAtEachStep("결제 입력", `/orders/${created.data.id}/payments`, { method: "BANK_TRANSFER", amountKrw: "20000", externalReference: "MID-1", paidAt: PAST }, 201);
  });
});
