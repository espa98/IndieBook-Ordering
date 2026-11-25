// 마이그레이션 적용 도구의 본체. 환경 변수(DATABASE_URL)만 읽고 접속 정보를 출력하지 않는다.
// 기본은 읽기 전용 드라이런이다. 실제 적용은 `--apply`와 접속 대상 호스트를 직접 적은 `--confirm-host`가 모두 있어야 한다.
import pg from "pg";
import { applyMigrations, planMigrations } from "../src/db/migrate";

export type MigrateIo = { log: (message: string) => void; error: (message: string) => void };

/** 종료 코드: 0 성공(드라이런 포함), 1 적용 차단(점검 실패), 2 사용 오류 */
export async function runMigrateCli(env: Record<string, string | undefined>, argv: string[], io: MigrateIo, dir: string): Promise<number> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    io.error("DATABASE_URL이 필요하다. 접속 문자열은 환경 변수로만 받는다.");
    return 2;
  }
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    io.error("DATABASE_URL 형식이 올바르지 않다."); // 값은 출력하지 않는다
    return 2;
  }
  const apply = argv.includes("--apply");
  if (apply) {
    // 실수로 다른 DB(예: 레거시 ordering-dev)에 적용하지 않도록 접속 호스트를 직접 적게 한다
    const at = argv.indexOf("--confirm-host");
    const confirmed = at >= 0 ? argv[at + 1] : undefined;
    if (confirmed === undefined) {
      io.error(`--apply에는 --confirm-host <호스트>가 필요하다. 이 접속의 호스트: ${target.hostname}`);
      return 2;
    }
    if (confirmed !== target.hostname) {
      io.error("--confirm-host가 DATABASE_URL의 호스트와 다르다. 적용하지 않는다.");
      return 2;
    }
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const plan = await planMigrations(client, dir);
    io.log(`대상: ${target.hostname}:${target.port || "5432"}${target.pathname} (${apply ? "적용" : "드라이런"})`);
    io.log(`적용됨 ${plan.applied.length}개, 대기 ${plan.pending.length}개`);
    for (const file of plan.pending) io.log(`  대기: ${file}`);
    for (const blocker of plan.blockers) io.error(`차단: ${blocker}`);
    if (plan.blockers.length > 0) return 1;
    if (!apply) return 0;
    const done = await applyMigrations(client, dir);
    for (const file of done) io.log(`적용: ${file}`);
    io.log(`완료: ${done.length}개 적용`);
    return 0;
  } catch (error) {
    // 접속·점검·적용 실패: 원인 메시지만 알리고 비밀번호·접속 문자열은 가린다
    let message = error instanceof Error ? error.message : "알 수 없는 오류";
    for (const secret of [databaseUrl, decodeURIComponent(target.password), target.password]) {
      if (secret) message = message.split(secret).join("***");
    }
    io.error(`접속 또는 점검에 실패했다: ${message}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}
