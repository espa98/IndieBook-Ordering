import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrateCli } from "../../server/migrateCli";
import { startIsolatedPostgres, type IsolatedPostgres } from "../helpers/isolatedPostgres";

const DIR = join(process.cwd(), "db/migrations");
const PASSWORD = "isolated-test-only";

let db: IsolatedPostgres;
let url: string;
beforeAll(async () => {
  db = await startIsolatedPostgres();
  url = `postgresql://postgres:${PASSWORD}@127.0.0.1:${db.port}/bookflow_test`;
  const c = await db.connect();
  await c.query(readFileSync(join(process.cwd(), "db/test-support/supabase_shim.sql"), "utf8"));
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const run = async (env: Record<string, string | undefined>, argv: string[]) => {
  const lines: string[] = [];
  const code = await runMigrateCli(env, argv, { log: (m) => void lines.push(m), error: (m) => void lines.push(m) }, DIR);
  return { code, output: lines.join("\n") };
};
const hasTracking = async () => {
  const c = await db.connect();
  try {
    return (await c.query("select to_regclass('public.ordering_schema_migrations') as t")).rows[0].t !== null;
  } finally {
    await c.end();
  }
};

describe("migrate CLI: 기본은 읽기 전용 드라이런", () => {
  it("DATABASE_URL이 없으면 거부하고, 있으면 대기 목록만 보여 주며(아무것도 적용·생성하지 않고) 접속 정보는 출력하지 않는다", async () => {
    const missing = await run({}, []);
    expect(missing.code).toBe(2);
    expect(missing.output).toMatch(/DATABASE_URL/);

    const dry = await run({ DATABASE_URL: url }, []);
    expect(dry.code).toBe(0);
    expect(dry.output).toMatch(/드라이런/);
    expect(dry.output).toMatch(/001_foundation\.sql/);
    expect(dry.output).toMatch(/127\.0\.0\.1/); // 대상 호스트는 보여 준다
    expect(dry.output).not.toContain(PASSWORD);
    expect(dry.output).not.toContain(url);
    expect(await hasTracking()).toBe(false);
  });

  it("--apply는 --confirm-host가 접속 호스트와 정확히 같을 때만 적용하고, 점검이 차단하면 확인했어도 적용하지 않으며, 다시 실행해도 대기가 없다", async () => {
    // 레거시처럼 이력 없는 ordering 테이블이 있으면 확인했어도 거부한다
    const c = await db.connect();
    await c.query("create table public.ordering_tenants (id uuid primary key)");
    const blocked = await run({ DATABASE_URL: url }, ["--apply", "--confirm-host", "127.0.0.1"]);
    expect(blocked.code).toBe(1);
    expect(blocked.output).toMatch(/차단/);
    expect(await hasTracking()).toBe(false);
    await c.query("drop table public.ordering_tenants");
    await c.end();

    const noConfirm = await run({ DATABASE_URL: url }, ["--apply"]);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.output).toMatch(/--confirm-host/);
    const wrong = await run({ DATABASE_URL: url }, ["--apply", "--confirm-host", "localhost"]);
    expect(wrong.code).toBe(2);
    expect(await hasTracking()).toBe(false);

    const applied = await run({ DATABASE_URL: url }, ["--apply", "--confirm-host", "127.0.0.1"]);
    expect(applied.code).toBe(0);
    expect(applied.output).toMatch(/024_audit_log\.sql/);
    expect(applied.output).not.toContain(PASSWORD);
    const again = await run({ DATABASE_URL: url }, []);
    expect(again.code).toBe(0);
    expect(again.output).toMatch(/대기 0개/);
  });

  it("접속에 실패하면 코드 1과 원인만 알리고 비밀번호·접속 문자열은 출력하지 않는다", async () => {
    const bad = `postgresql://postgres:${PASSWORD}@127.0.0.1:1/bookflow_test`; // 닫힌 포트
    const result = await run({ DATABASE_URL: bad }, []);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/접속|점검/);
    expect(result.output).not.toContain(PASSWORD);
    expect(result.output).not.toContain(bad);
    expect((await run({ DATABASE_URL: "not a url" }, [])).code).toBe(2);
  });
});
