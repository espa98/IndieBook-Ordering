import type { JwtKey, JwtVerifyOptions } from "../src/auth/jwt";

export type ServerConfig = {
  /** 백엔드가 쓰는 DB 연결 문자열. 코드·저장소에 두지 않고 환경에서만 받는다 */
  databaseUrl: string;
  port: number;
  maxBodyBytes: number;
  /** DB 쿼리 하나의 시간 제한(ms). 잠금 대기도 포함한다. 무제한은 허용하지 않는다 */
  statementTimeoutMs: number;
  /** 종결 스위퍼 실행 간격(초). 0이면 끈다 */
  closureSweepIntervalSeconds: number;
  jwt: JwtVerifyOptions;
  /** CORS를 허용하는 브라우저 오리진(정확히 일치). 기본은 빈 목록 */
  allowedOrigins: string[];
};

const fail = (message: string): never => {
  // 오류 메시지에 값(연결 문자열·비밀)을 싣지 않는다
  throw new Error(`invalid server configuration: ${message}`);
};

function integer(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fail(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function parseKeys(raw: string): JwtKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("SUPABASE_JWT_KEYS must be valid JSON");
  }
  if (!Array.isArray(parsed)) return fail("SUPABASE_JWT_KEYS must be a JSON array");
  return parsed.map((entry): JwtKey => {
    const e = entry as { kid?: unknown; alg?: unknown; key?: unknown };
    if ((e.alg !== "RS256" && e.alg !== "ES256") || (typeof e.key !== "string" && (typeof e.key !== "object" || e.key === null))) {
      return fail("SUPABASE_JWT_KEYS entries need an asymmetric alg (RS256 or ES256) and a public key");
    }
    return { ...(typeof e.kid === "string" ? { kid: e.kid } : {}), alg: e.alg, key: e.key as JsonWebKey | string };
  });
}

/** 쉼표로 구분한 오리진 목록. 스킴·호스트·포트만 있는 정확한 오리진만 받는다(와일드카드·경로·중복 거부) */
function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const origins = raw.split(",").map((o) => o.trim());
  for (const origin of origins) {
    let url: URL | undefined;
    try {
      url = new URL(origin);
    } catch {
      url = undefined;
    }
    if (origin.includes("*") || !url || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin) {
      return fail("CORS_ALLOWED_ORIGINS must be a comma-separated list of exact origins such as https://app.example.com");
    }
  }
  if (new Set(origins).size !== origins.length) return fail("CORS_ALLOWED_ORIGINS must not contain duplicates");
  return origins;
}

/**
 * 환경 변수에서 서버 설정을 만든다(순수 함수). 서명 키는 둘 중 하나 이상 필요하다:
 * SUPABASE_JWT_KEYS(RS256/ES256 공개 키 JSON 배열), SUPABASE_JWT_SECRET(HS256 비밀, 32자 이상).
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return fail("DATABASE_URL is required");
  const keys: JwtKey[] = env.SUPABASE_JWT_KEYS ? parseKeys(env.SUPABASE_JWT_KEYS) : [];
  const secret = env.SUPABASE_JWT_SECRET;
  if (secret !== undefined && secret !== "") {
    if (secret.length < 32) return fail("SUPABASE_JWT_SECRET must be at least 32 characters");
    keys.push({ alg: "HS256", key: secret });
  }
  if (keys.length === 0) return fail("SUPABASE_JWT_KEYS or SUPABASE_JWT_SECRET is required");
  return {
    databaseUrl,
    port: integer(env, "PORT", 8080, 1, 65535),
    maxBodyBytes: integer(env, "MAX_BODY_BYTES", 1024 * 1024, 1, 64 * 1024 * 1024),
    statementTimeoutMs: integer(env, "DB_STATEMENT_TIMEOUT_MS", 10_000, 100, 120_000),
    closureSweepIntervalSeconds: integer(env, "CLOSURE_SWEEP_INTERVAL_SECONDS", 300, 0, 86_400),
    allowedOrigins: parseOrigins(env.CORS_ALLOWED_ORIGINS),
    jwt: { keys, audience: "authenticated", ...(env.SUPABASE_JWT_ISSUER ? { issuer: env.SUPABASE_JWT_ISSUER } : {}) },
  };
}
