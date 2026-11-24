// 서버 실행 진입점. 환경 변수만 읽고 어떤 비밀도 코드에 두지 않는다.
// 연결 문자열이 가리키는 DB는 이 서버를 띄우는 사람이 책임진다(이 저장소는 어떤 외부 DB에도 접속 정보를 갖지 않는다).
// 백엔드는 `service_role`로 `SET LOCAL ROLE` 할 수 있는 DB 사용자로 접속해야 한다.
import pg from "pg";
import { createApp } from "../src/http/app";
import { createHttpServer } from "../src/http/server";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on("error", (error) => console.error("database pool error:", error.message));

const app = createApp({
  pool,
  jwt: config.jwt,
  // 내부 오류의 원본은 서버 로그에만 남기고 응답에는 싣지 않는다
  logError: (error) => console.error("unhandled request error:", error instanceof Error ? error.stack : error),
});
const server = createHttpServer(app, { maxBodyBytes: config.maxBodyBytes });

server.listen(config.port, () => console.log(`ordering server listening on port ${config.port}`));

async function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
