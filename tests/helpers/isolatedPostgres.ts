import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

/**
 * 격리 테스트 DB: 이 프로세스가 임시 폴더에 직접 띄우는 로컬 Postgres다.
 * `ordering-dev`·`testBookshare` 등 어떤 외부 DB에도 접속하지 않는다(접속 정보가 코드에 없다).
 */
export type IsolatedPostgres = {
  port: number;
  /** 새 독립 연결을 연다. 호출자가 end()한다 */
  connect(database?: string): Promise<pg.Client>;
  /** 백엔드처럼 여러 연결을 돌려 쓰는 풀. stop()이 함께 닫는다 */
  pool(database?: string): pg.Pool;
  stop(): Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
    server.on("error", reject);
  });
}

const START_ATTEMPTS = 4;

/**
 * 빈 포트를 고르고 서버를 띄운다. 전체 테스트가 여러 서버를 동시에 띄우므로 포트를 고른 뒤 다른 프로세스가
 * 가로채거나 초기화가 겹쳐 실패할 수 있다. 그럴 때는 새 포트·새 폴더로 다시 시도한다.
 */
async function bootServer(): Promise<{ dir: string; port: number; server: EmbeddedPostgres }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), "bookflow-pg-"));
    const port = await freePort();
    const server = new EmbeddedPostgres({
      databaseDir: join(dir, "data"),
      user: "postgres",
      password: "isolated-test-only",
      port,
      persistent: false,
    });
    try {
      await server.initialise();
      await server.start();
      await server.createDatabase("bookflow_test");
      return { dir, port, server };
    } catch (error) {
      lastError = error;
      await server.stop().catch(() => undefined);
      removeBestEffort(dir);
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw lastError;
}

/** 임시 DB 폴더를 지운다. Windows에서 백신·인덱서가 파일을 잡고 있으면 `EBUSY`가 길게 이어질 수 있다.
 * 정리 실패는 검증 결과와 무관하므로 오래 재시도한 뒤에도 안 되면 OS 임시 폴더에 남기고 넘어간다. */
function removeBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 임시 폴더가 남을 뿐이다 */
  }
}

/** 비영속 모드의 `stop()`은 서버를 멈춘 뒤 데이터 폴더를 직접 지운다. 그 삭제가 파일 잠금(`EBUSY` 등)으로 실패해도
 * 서버는 이미 멈췄으므로 무시하고, 다른 오류는 그대로 던진다. */
async function stopIgnoringCleanupLock(server: { stop(): Promise<void> }): Promise<void> {
  try {
    await server.stop();
  } catch (error) {
    if (!/EBUSY|EPERM|ENOTEMPTY/.test(String(error))) throw error;
  }
}

export async function startIsolatedPostgres(): Promise<IsolatedPostgres> {
  const { dir, port, server } = await bootServer();
  const pools: pg.Pool[] = [];
  return {
    port,
    async connect(database = "bookflow_test") {
      const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "isolated-test-only", database });
      await client.connect();
      return client;
    },
    pool(database = "bookflow_test") {
      const pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password: "isolated-test-only", database, max: 8, idleTimeoutMillis: 1_000 });
      pools.push(pool);
      return pool;
    },
    async stop() {
      await Promise.all(pools.map((p) => p.end()));
      await stopIgnoringCleanupLock(server);
      removeBestEffort(dir);
    },
  };
}
