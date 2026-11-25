import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMigrate } from "../../server/build";
import { startIsolatedPostgres, type IsolatedPostgres } from "../helpers/isolatedPostgres";

let db: IsolatedPostgres;
let dir: string;
let bundle: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bookflow-migrate-bundle-"));
  bundle = join(dir, "migrate.mjs");
  await buildMigrate(bundle);
  db = await startIsolatedPostgres();
  const c = await db.connect();
  await c.query(readFileSync(join(process.cwd(), "db/test-support/supabase_shim.sql"), "utf8"));
  await c.end();
}, 240_000);
afterAll(async () => {
  await db?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

const exec = (env: Record<string, string>, args: string[] = []) =>
  spawnSync(process.execPath, [bundle, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 60_000 });

describe("migrate 번들: node만으로 실행된다", () => {
  it("번들한 CLI가 소스 없이 실행되어 드라이런·사용 오류의 종료 코드를 낸다", () => {
    const migrations = join(process.cwd(), "db/migrations");
    const url = `postgresql://postgres:isolated-test-only@127.0.0.1:${db.port}/bookflow_test`;

    const noUrl = exec({ MIGRATIONS_DIR: migrations });
    expect(noUrl.status).toBe(2);
    expect(noUrl.stderr).toMatch(/DATABASE_URL/);

    const dry = exec({ DATABASE_URL: url, MIGRATIONS_DIR: migrations });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/드라이런/);
    expect(dry.stdout).toMatch(/대기 2\d개/);
    expect(dry.stdout + dry.stderr).not.toContain("isolated-test-only");
  });
});
