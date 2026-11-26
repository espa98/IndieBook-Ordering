import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 저장 도중 실패 주입(T4): 연결 끊김: 명령이 실행하는 k번째 쓰기(감사 제외)에서 실패시키고 k를 올리며 매번 DB 전체가 그대로인지 확인한다. 쓰기 수를 넘겨 성공한 실행이 실제 실행이다.
 */
const SECRET = "dropconn-rollback-secret-0123456789abcdef0123";
const T = "aaaaaaaa-0000-4000-8000-000000000004";
const OWNER = "11111111-0000-4000-8000-000000000004";
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
    await c.query(`create or replace function public.__kth_fault() returns trigger language plpgsql security definer as $$ declare cur int; tgt int; begin update public.__fault_state set n = n + 1 returning n, target into cur, tgt; if cur = tgt then perform pg_terminate_backend(pg_backend_pid()); perform pg_sleep(5); end if; return coalesce(new, old); end $$`);
    for (const t of tables) await c.query(`create trigger __kth_fault before insert or update or delete on public.${t} for each row execute function public.__kth_fault()`);
  } finally {
    await c.end();
  }
}

const NEWBIE = "77777777-0000-4000-8000-000000000001";
const NEWBIE_EMAIL = "newbie@shop.test";
let seq = 0;
async function call(userId: string, email: string, path: string, body: unknown, scope: "account" | "tenant" = "account") {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: userId, email, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "idempotency-key": `acct-${++seq}`, "content-type": "application/json" };
  const prefix = scope === "tenant" ? `/v1/tenants/${T}` : "/v1";
  const response = await app({ method: "POST", path: `${prefix}${path}`, query: new URLSearchParams(), headers, rawBody: JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

async function failingAtEachStep(label: string, run: () => ReturnType<typeof call>, status: number) {
  for (let k = 1; k <= 40; k++) {
    const before = await snapshot();
    await failOnKthWrite(k);
    const r = await run();
    await failOnKthWrite(0);
    if (r.status !== 500) {
      expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(status);
      expect(k, `${label}: 쓰기가 한 번도 실패하지 않았다`).toBeGreaterThan(1);
      return { data: r.body.data, steps: k - 1 };
    }
    expect(diff(before, await snapshot()), `${label}: ${k}번째 쓰기 실패 뒤 변경된 테이블`).toEqual([]);
  }
  throw new Error(`${label}: 쓰기가 40번을 넘는다`);
}

describe("저장 도중 연결이 끊겨도 아무것도 남지 않는다", { timeout: 300_000 }, () => {
  it("서점 개설: k번째 쓰기에서 서버가 연결을 끊으면 오류로 끝나고 DB가 그대로이며, 이후 정상 요청이 성공한다", async () => {
    let dropped = 0;
    for (let k = 1; k <= 40; k++) {
      const before = await snapshot();
      await failOnKthWrite(k);
      const r = await call(NEWBIE, NEWBIE_EMAIL, "/stores", { storeName: "연결 끊김 서점" });
      await failOnKthWrite(0);
      if (r.status === 201) break;
      expect(r.status, `${k}번째 쓰기에서 끊김: ${JSON.stringify(r.body)}`).toBe(500);
      expect(diff(before, await snapshot()), `${k}번째 쓰기 연결 끊김 뒤 변경된 테이블`).toEqual([]);
      dropped = k;
    }
    expect(dropped).toBeGreaterThanOrEqual(2);
    // 끊긴 연결이 풀에 남아 다음 요청을 망치지 않는다: 이미 만든 서점은 같은 이름이라 BUSINESS_INVARIANT, 다른 이름은 새로 성공
    const again = await call(NEWBIE, NEWBIE_EMAIL, "/stores", { storeName: "연결 끊김 뒤 서점" });
    expect(again.status).toBe(201);
  });
});
