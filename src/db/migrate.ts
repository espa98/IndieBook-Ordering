import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";

const MIGRATIONS_TABLE = "ordering_schema_migrations";

/** 체크아웃 환경에 따라 달라지는 줄바꿈(CRLF)은 내용 변경으로 보지 않는다 */
const checksumOf = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
const migrationFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

export type MigrationPlan = {
  /** 이미 적용된 파일 */
  applied: string[];
  /** 적용할 파일(파일명 순) */
  pending: string[];
  /** 적용하면 안 되는 이유. 비어 있어야 적용할 수 있다 */
  blockers: string[];
};

/**
 * 적용하기 전에 대상 DB를 **읽기만 해서** 점검한다(이력 테이블도 만들지 않는다). 호출자는 이 결과의 `blockers`가
 * 비어 있을 때만 `applyMigrations`를 부른다.
 */
export async function planMigrations(client: Client, dir: string): Promise<MigrationPlan> {
  const files = migrationFiles(dir);
  const tracked = (await client.query("select to_regclass('public.ordering_schema_migrations') as t")).rows[0].t !== null;
  const applied = new Map<string, string>(
    tracked
      ? (await client.query(`select version, checksum from public.${MIGRATIONS_TABLE}`)).rows.map((row: { version: string; checksum: string }) => [row.version, row.checksum])
      : [],
  );
  const blockers: string[] = [];
  if (!tracked) {
    // 이력이 없는데 ordering 테이블이 있으면 이 저장소의 마이그레이션이 만든 DB가 아니다(예: 레거시 `ordering-dev`).
    // `create table`이 실패하거나 남의 테이블 위에 일부만 적용될 수 있으므로 적용하지 않는다
    const existing = (
      await client.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name like 'ordering%' order by table_name")
    ).rows.map((row: { table_name: string }) => row.table_name);
    if (existing.length > 0) {
      blockers.push(`이 저장소가 만들지 않은 ordering 테이블이 이미 있다(${existing.join(", ")}). 새 프로젝트(빈 DB)에만 적용할 수 있다`);
    }
  }
  // 마이그레이션은 Supabase의 역할(anon·authenticated·service_role)과 auth.uid()를 전제한다(RLS V2.2)
  const roles = (await client.query("select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')")).rows.map((row: { rolname: string }) => row.rolname);
  const missingRoles = ["anon", "authenticated", "service_role"].filter((role) => !roles.includes(role));
  if (missingRoles.length > 0) blockers.push(`Supabase 역할이 없다(${missingRoles.join(", ")}). Supabase 프로젝트가 아닌 DB에는 적용하지 않는다`);
  if ((await client.query("select to_regprocedure('auth.uid()') as f")).rows[0].f === null) {
    blockers.push("auth.uid()가 없다. Supabase Auth가 있는 프로젝트에만 적용할 수 있다");
  }
  // 이미 적용한 파일의 내용이 달라졌으면 적용 도구가 거부하므로 미리 알린다
  for (const file of files) {
    const recorded = applied.get(file);
    if (recorded !== undefined && recorded !== checksumOf(readFileSync(join(dir, file), "utf8"))) {
      blockers.push(`${file}이(가) 적용된 뒤에 바뀌었다`);
    }
  }
  return { applied: files.filter((f) => applied.has(f)), pending: files.filter((f) => !applied.has(f)), blockers };
}

/**
 * `dir`의 `*.sql` 파일을 파일명 순서대로 한 번씩 적용한다. 각 파일은 하나의 트랜잭션이라
 * 실패하면 통째로 롤백되고 기록되지 않는다. 이미 적용한 파일의 내용이 바뀌면 거부한다.
 * 호출자는 대상 DB가 격리 테스트 DB 또는 승인된 환경인지 책임진다. 접속 정보를 만들지 않는다.
 */
export async function applyMigrations(client: Client, dir: string): Promise<string[]> {
  await client.query(
    `create table if not exists public.${MIGRATIONS_TABLE} (
       version text primary key,
       checksum text not null,
       applied_at timestamptz not null default now()
     )`,
  );
  const applied = new Map<string, string>(
    (await client.query(`select version, checksum from public.${MIGRATIONS_TABLE}`)).rows.map(
      (row: { version: string; checksum: string }) => [row.version, row.checksum],
    ),
  );
  const files = migrationFiles(dir);
  const newlyApplied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    // 체크아웃 환경에 따라 달라지는 줄바꿈(CRLF)은 내용 변경으로 보지 않는다
    const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
    const previous = applied.get(file);
    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(`migration ${file} changed after it was applied`);
      }
      continue;
    }
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(`insert into public.${MIGRATIONS_TABLE} (version, checksum) values ($1, $2)`, [file, checksum]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    newlyApplied.push(file);
  }
  return newlyApplied;
}
