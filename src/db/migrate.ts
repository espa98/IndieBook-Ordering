import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";

const MIGRATIONS_TABLE = "ordering_schema_migrations";

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
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
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
