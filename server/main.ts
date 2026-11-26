// 서버 실행 진입점. 환경 변수만 읽고 어떤 비밀도 코드에 두지 않는다.
// 연결 문자열이 가리키는 DB는 이 서버를 띄우는 사람이 책임진다(이 저장소는 어떤 외부 DB에도 접속 정보를 갖지 않는다).
// 백엔드는 `service_role`로 `SET LOCAL ROLE` 할 수 있는 DB 사용자로 접속해야 한다.
import { createPgCancellationApi } from "../src/db/pgCancellationApi";
import { createPgProcurementApi } from "../src/db/pgProcurementApi";
import { createApp } from "../src/http/app";
import { createHttpServer } from "../src/http/server";
import { createClosureSweeper } from "../src/jobs/closureSweeper";
import { startSweepLoop } from "../src/jobs/sweepLoop";
import { loadConfig } from "./config";
import { createDatabasePool } from "./pool";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  // 설정 오류는 메시지만 출력한다(스택·값 비노출). 시작하지 않는다
  console.error(error instanceof Error ? error.message : "invalid server configuration");
  process.exit(1);
}
const pool = createDatabasePool({ databaseUrl: config.databaseUrl, statementTimeoutMs: config.statementTimeoutMs });
pool.on("error", (error) => console.error("database pool error:", error.message));

const app = createApp({
  pool,
  jwt: config.jwt,
  // 내부 오류의 원본은 서버 로그에만 남기고 응답에는 싣지 않는다
  logError: (error) => console.error("unhandled request error:", error instanceof Error ? error.stack : error),
});
const server = createHttpServer(app, { maxBodyBytes: config.maxBodyBytes, allowedOrigins: config.allowedOrigins });

server.listen(config.port, () => console.log(`ordering server listening on port ${config.port}`));

// 종결 스위퍼: 종결 요청이 있는 주문과 진행 중인 발주의 서버 전용 종결 실행을 주기적으로 부른다(0이면 끈다).
// 여러 인스턴스를 띄워도 DB 어드바이저리 락으로 한 번에 하나만 돈다.
const sweeper = createClosureSweeper({
  pool,
  cancellations: createPgCancellationApi({ pool }),
  procurement: createPgProcurementApi({ pool }),
  logError: (error) => console.error("closure sweep error:", error instanceof Error ? error.message : "unknown error"),
});
const sweepLoop = startSweepLoop({
  intervalMs: config.closureSweepIntervalSeconds * 1000,
  run: async () => {
    const result = await sweeper.runOnce();
    if (!result.skipped && (result.orders.closed > 0 || result.purchaseOrders.closed > 0 || result.reopenings.reopened > 0 || result.orders.failed > 0 || result.purchaseOrders.failed > 0 || result.reopenings.failed > 0)) {
      console.log(`closure sweep: orders closed=${result.orders.closed} blocked=${result.orders.blocked} failed=${result.orders.failed}, reopened=${result.reopenings.reopened} failed=${result.reopenings.failed}, purchaseOrders closed=${result.purchaseOrders.closed} blocked=${result.purchaseOrders.blocked} failed=${result.purchaseOrders.failed}`);
    }
  },
  logError: (error) => console.error("closure sweep error:", error instanceof Error ? error.message : "unknown error"),
});

async function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`);
  server.close(async () => {
    await sweepLoop.stop();
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
