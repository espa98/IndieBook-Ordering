import pg from "pg";

export type DatabasePoolOptions = { databaseUrl: string; statementTimeoutMs: number; max?: number };

/**
 * 백엔드의 DB 풀. 쿼리 하나의 시간 제한(`statement_timeout`)을 모든 연결에 건다.
 * 잠금 대기도 포함하므로, 다른 세션이 잠근 행을 기다리는 요청이 연결을 쥔 채 영원히 매달려 풀이 마르는 일을 막는다.
 */
export function createDatabasePool(options: DatabasePoolOptions): pg.Pool {
  return new pg.Pool({ connectionString: options.databaseUrl, max: options.max ?? 10, statement_timeout: options.statementTimeoutMs });
}
