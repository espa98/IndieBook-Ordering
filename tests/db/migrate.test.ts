import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { startIsolatedPostgres, type IsolatedPostgres } from "../helpers/isolatedPostgres";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startIsolatedPostgres();
}, 120_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

function migrationDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "bookflow-mig-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("applyMigrations: 마이그레이션 러너", () => {
  it("파일명 순서대로 한 번씩만 적용하고 다시 실행하면 아무것도 적용하지 않는다", async () => {
    const m = migrationDir({
      "002_second.sql": "alter table mig_a add column note text;",
      "001_first.sql": "create table mig_a (id int primary key);",
      "README.md": "무시되는 파일",
    });
    const client = await db.connect();
    try {
      expect(await applyMigrations(client, m.dir)).toEqual(["001_first.sql", "002_second.sql"]);
      expect(await applyMigrations(client, m.dir)).toEqual([]);
      const columns = (await client.query("select column_name from information_schema.columns where table_name = 'mig_a' order by 1")).rows;
      expect(columns.map((c) => c.column_name)).toEqual(["id", "note"]);
    } finally {
      await client.end();
      m.cleanup();
    }
  });

  it("실패한 마이그레이션은 통째로 롤백되고 기록되지 않으며, 이미 적용된 파일이 바뀌면 거부한다", async () => {
    const client = await db.connect();
    const bad = migrationDir({ "010_bad.sql": "create table mig_b (id int); select 1/0;" });
    try {
      await expect(applyMigrations(client, bad.dir)).rejects.toThrow();
      expect((await client.query("select to_regclass('public.mig_b') as t")).rows[0].t).toBeNull();
      expect((await client.query("select count(*)::int as n from ordering_schema_migrations where version = '010_bad.sql'")).rows[0].n).toBe(0);
    } finally {
      bad.cleanup();
    }
    const good = migrationDir({ "020_good.sql": "create table mig_c (id int);" });
    try {
      await applyMigrations(client, good.dir);
      writeFileSync(join(good.dir, "020_good.sql"), "create table mig_c (id int, extra int);"); // 적용 뒤 수정
      await expect(applyMigrations(client, good.dir)).rejects.toThrow(/changed after it was applied/);
    } finally {
      await client.end();
      good.cleanup();
    }
  });

  it("줄바꿈(CRLF/LF)만 다른 같은 파일은 변경으로 보지 않는다 (체크아웃 환경이 달라도 안전)", async () => {
    const m = migrationDir({ "030_eol.sql": "create table mig_d (id int);\nselect 1;\n" });
    const client = await db.connect();
    try {
      await applyMigrations(client, m.dir);
      writeFileSync(join(m.dir, "030_eol.sql"), "create table mig_d (id int);\r\nselect 1;\r\n");
      expect(await applyMigrations(client, m.dir)).toEqual([]);
    } finally {
      await client.end();
      m.cleanup();
    }
  });
});
