import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, planMigrations } from "../../src/db/migrate";
import { startIsolatedPostgres, type IsolatedPostgres } from "../helpers/isolatedPostgres";

const DIR = join(process.cwd(), "db/migrations");
const ALL = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startIsolatedPostgres();
  const c = await db.connect();
  await c.query(readFileSync(join(process.cwd(), "db/test-support/supabase_shim.sql"), "utf8")); // Supabase 흉내(역할·auth.uid)만 있는 새 DB
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("planMigrations: 적용 전 읽기 전용 점검", () => {
  it("새 Supabase 같은 빈 DB에서는 모든 마이그레이션이 대기이고 차단 사유가 없으며, 점검이 DB에 아무것도 만들지 않는다", async () => {
    const client = await db.connect();
    try {
      const plan = await planMigrations(client, DIR);
      expect(plan).toEqual({ applied: [], pending: ALL, blockers: [] });
      expect(ALL.length).toBeGreaterThanOrEqual(24);
      // 점검만으로는 이력 테이블도 만들어지지 않는다
      expect((await client.query("select to_regclass('public.ordering_schema_migrations') as t")).rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  it("이력 없이 ordering 테이블이 이미 있으면(레거시 DB) 적용을 차단하고, 점검은 여전히 아무것도 바꾸지 않는다", async () => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("create table public.ordering_tenants (id uuid primary key, name text)"); // 레거시 ordering-dev와 같은 이름
      await client.query("create table public.ordering_events (id uuid primary key)");
      const plan = await planMigrations(client, DIR);
      expect(plan.pending).toEqual(ALL);
      expect(plan.blockers).toHaveLength(1);
      expect(plan.blockers[0]).toMatch(/ordering_events, ordering_tenants/); // 이름순으로 모두 알려 준다
      expect(plan.blockers[0]).toMatch(/새 프로젝트/);
      await client.query("rollback");
      expect((await planMigrations(client, DIR)).blockers).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("Supabase가 아닌 DB(auth.uid() 없음)는 차단하고, 적용이 끝난 DB는 대기가 없으며, 적용된 파일이 바뀌면 차단한다", async () => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("drop function auth.uid()");
      const plan = await planMigrations(client, DIR);
      expect(plan.blockers.some((b) => /auth\.uid\(\)/.test(b))).toBe(true);
      await client.query("rollback");

      expect(await applyMigrations(client, DIR)).toEqual(ALL);
      expect(await planMigrations(client, DIR)).toEqual({ applied: ALL, pending: [], blockers: [] });

      // 적용된 파일의 내용이 달라진 디렉터리: 이력과 체크섬이 맞지 않으면 차단한다
      const { mkdtempSync, writeFileSync, cpSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const copy = mkdtempSync(join(tmpdir(), "bookflow-plan-"));
      try {
        cpSync(DIR, copy, { recursive: true });
        writeFileSync(join(copy, ALL[0]!), readFileSync(join(DIR, ALL[0]!), "utf8") + "\n-- 바뀐 내용\n");
        const changed = await planMigrations(client, copy);
        expect(changed.blockers).toHaveLength(1);
        expect(changed.blockers[0]).toContain(ALL[0]);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    } finally {
      await client.end();
    }
  }, 120_000);
});
