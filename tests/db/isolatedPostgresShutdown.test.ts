import { describe, expect, it } from "vitest";
import { startIsolatedPostgres } from "../helpers/isolatedPostgres";

/**
 * 시험이 연결을 닫지 않고 끝나도(누수) 서버를 멈출 때 처리되지 않은 오류로 전체 실행이 깨지면 안 된다.
 * 서버가 멈추면 열려 있는 연결이 FATAL(57P01)을 'error' 이벤트로 내는데, 받는 쪽이 없으면 프로세스 전체의 처리되지 않은 오류가 된다.
 * (전체 실행에서 시험은 통과했는데 "Unhandled Errors"로 실패한 원인 부류)
 */
describe("격리 Postgres 종료", () => {
  it("닫지 않은 연결·풀이 남아 있어도 stop()이 처리되지 않은 오류를 내지 않고, 연결도 끊어 둔다", async () => {
    const db = await startIsolatedPostgres();
    const uncaught: unknown[] = [];
    const onError = (error: unknown) => void uncaught.push(error);
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
    try {
      const leaked = await db.connect(); // 일부러 닫지 않는다
      await leaked.query("select 1");
      const pool = db.pool();
      await pool.query("select 1"); // 풀의 유휴 연결도 남긴다
      await db.stop();
      await new Promise((resolve) => setTimeout(resolve, 500)); // 늦게 오는 오류를 기다린다
      expect(uncaught.map(String)).toEqual([]);
    } finally {
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onError);
    }
  }, 120_000);
});
