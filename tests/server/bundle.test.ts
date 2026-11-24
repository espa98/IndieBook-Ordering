import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../server/build";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const SECRET = "bundle-test-only-secret-0123456789abcdef";
const T = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
let dir: string;
let bundle: string;
const children: ChildProcess[] = [];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bookflow-bundle-"));
  bundle = join(dir, "server.mjs");
  await buildServer(bundle);
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await c.end();
}, 240_000);
afterAll(async () => {
  for (const child of children) child.kill();
  await db?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

function start(env: Record<string, string>): { child: ChildProcess; ready: Promise<string>; output: () => string } {
  const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve(out);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("exit", () => clearTimeout(timer));
  });
  return { child, ready, output: () => out };
}

describe("서버 번들: 빌드한 단일 파일이 실제로 실행된다 (E8)", () => {
  it("번들은 하나의 ESM 파일이고 소스·시크릿·시험용 값을 담지 않는다", () => {
    const text = readFileSync(bundle, "utf8");
    expect(statSync(bundle).size).toBeGreaterThan(10_000);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("isolated-test-only");
    expect(text).not.toMatch(/ordering-dev|testBookshare/);
    expect(text).not.toContain("embedded-postgres"); // 개발 의존성은 번들에 들어가지 않는다
  });

  it("설정 환경 변수로 기동해 /healthz와 인증된 요청에 응답하고, SIGTERM으로 정상 종료한다", async () => {
    const port = await freePort();
    const { child, ready } = start({
      DATABASE_URL: `postgres://postgres:isolated-test-only@127.0.0.1:${db.port}/bookflow_test`,
      SUPABASE_JWT_SECRET: SECRET,
      PORT: String(port),
    });
    await ready;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/tenants/${T}/orders`);
    expect(anonymous.status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const jwt = signHs256({ sub: OWNER, aud: "authenticated", exp: now + 600 }, SECRET);
    const authed = await fetch(`http://127.0.0.1:${port}/v1/tenants/${T}/orders`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ data: { items: [] } });

    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    // 윈도우에서는 시그널이 즉시 종료로 처리될 수 있어 종료 사실만 확인한다
    expect(await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))])).not.toBe("timeout");
  });

  it("필수 설정이 없으면 시작하지 않고(0이 아닌 종료 코드) 오류에 접속 정보·비밀을 싣지 않는다", () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [bundle], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 20_000 });

    const noDb = run({ SUPABASE_JWT_SECRET: SECRET });
    expect(noDb.status).not.toBe(0);
    expect(noDb.stderr).toMatch(/DATABASE_URL is required/);
    const weak = run({ DATABASE_URL: "postgres://user:hunter2@db.internal/ordering", SUPABASE_JWT_SECRET: "short" });
    expect(weak.status).not.toBe(0);
    expect(weak.stderr).toMatch(/at least 32/);
    expect(weak.stderr + weak.stdout).not.toContain("hunter2");
  });
});
