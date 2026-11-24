import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { applyMigrations } from "../../src/db/migrate";
import { startIsolatedPostgres, type IsolatedPostgres } from "./isolatedPostgres";

const ROOT = process.cwd();

/** 격리 Postgres에 Supabase 흉내(shim)와 `db/migrations` 전체를 적용한 상태로 띄운다. */
export async function startMigratedPostgres(): Promise<IsolatedPostgres> {
  const db = await startIsolatedPostgres();
  const client = await db.connect();
  try {
    await client.query(readFileSync(join(ROOT, "db/test-support/supabase_shim.sql"), "utf8"));
    await applyMigrations(client, join(ROOT, "db/migrations"));
  } finally {
    await client.end();
  }
  return db;
}

export type Claims = { sub: string } & Record<string, unknown>;

/**
 * 한 트랜잭션 안에서 지정한 DB 역할과 JWT 클레임으로 실행하고 항상 롤백한다.
 * `claims`가 null이면 클레임 없는 요청(비로그인)이다.
 */
export async function withJwt<T>(
  client: Client,
  options: { role: "anon" | "authenticated" | "service_role"; claims: Claims | null },
  run: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query(`set local role ${options.role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      options.claims === null ? "" : JSON.stringify(options.claims),
    ]);
    return await run();
  } finally {
    await client.query("rollback");
  }
}

/** 오류 코드(SQLSTATE)만 돌려준다. 성공하면 undefined. */
export async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
