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

export async function startIsolatedPostgres(): Promise<IsolatedPostgres> {
  const dir = mkdtempSync(join(tmpdir(), "bookflow-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    user: "postgres",
    password: "isolated-test-only",
    port,
    persistent: false,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("bookflow_test");
  return {
    port,
    async connect(database = "bookflow_test") {
      const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "isolated-test-only", database });
      await client.connect();
      return client;
    },
    async stop() {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
