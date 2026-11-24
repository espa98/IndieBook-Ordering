import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB 통합 테스트는 격리 Postgres 위에서 트랜잭션을 여러 번 오가고, 전체 실행에서는 서버 여러 개가 동시에 떠 있다.
    // 기본 5초는 부하가 큰 실행에서 간헐적으로 부족했다. 논리 오류가 아니라 시간 초과였다.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
