// 마이그레이션 적용 진입점: `npm run migrate`(드라이런) / `npm run migrate -- --apply --confirm-host <호스트>`
// 번들(dist/migrate.mjs)은 저장소 체크아웃에서 실행한다(마이그레이션 파일은 ../db/migrations, MIGRATIONS_DIR로 바꿀 수 있다).
// 본체와 안전장치는 migrateCli.ts에 있다. 이 파일은 환경과 종료 코드만 연결한다.
import { join } from "node:path";
import { runMigrateCli } from "./migrateCli";

const code = await runMigrateCli(process.env, process.argv.slice(2), { log: (m) => console.log(m), error: (m) => console.error(m) }, process.env.MIGRATIONS_DIR ?? join(import.meta.dirname, "..", "db", "migrations"));
process.exit(code);
