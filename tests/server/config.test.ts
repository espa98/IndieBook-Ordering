import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/config";

const base = {
  DATABASE_URL: "postgres://app@db.internal:5432/ordering",
  SUPABASE_JWT_SECRET: "x".repeat(40),
};

describe("loadConfig: 서버 설정 해석 (비밀은 환경에서만)", () => {
  it("필수 값이 있으면 설정을 만들고 PORT 기본값은 8080, 본문 상한 기본은 1 MiB, aud는 authenticated이다", () => {
    const config = loadConfig(base);

    expect(config.databaseUrl).toBe(base.DATABASE_URL);
    expect(config.port).toBe(8080);
    expect(config.maxBodyBytes).toBe(1024 * 1024);
    expect(config.jwt).toEqual({ keys: [{ alg: "HS256", key: base.SUPABASE_JWT_SECRET }], audience: "authenticated" });
  });

  it("공개 키 목록(JWKS 형태)과 발급자·포트·본문 상한을 환경에서 받고, 두 방식을 함께 쓸 수 있다", () => {
    const jwks = JSON.stringify([{ kid: "k1", alg: "ES256", key: { kty: "EC", crv: "P-256", x: "a", y: "b" } }]);
    const config = loadConfig({ ...base, SUPABASE_JWT_KEYS: jwks, SUPABASE_JWT_ISSUER: "https://p.supabase.co/auth/v1", PORT: "9000", MAX_BODY_BYTES: "65536" });

    expect(config.port).toBe(9000);
    expect(config.maxBodyBytes).toBe(65536);
    expect(config.jwt.issuer).toBe("https://p.supabase.co/auth/v1");
    expect(config.jwt.keys.map((k) => k.alg)).toEqual(["ES256", "HS256"]);
  });

  it("DB 주소·서명 키가 없거나, 비밀이 짧거나, 키 JSON·포트·상한이 잘못되면 시작을 거부한다 (오류에 비밀을 싣지 않는다)", () => {
    const fails = (env: Record<string, string | undefined>) => {
      try {
        loadConfig(env);
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(fails({ SUPABASE_JWT_SECRET: base.SUPABASE_JWT_SECRET })).toMatch(/DATABASE_URL/);
    expect(fails({ DATABASE_URL: base.DATABASE_URL })).toMatch(/SUPABASE_JWT/);
    expect(fails({ ...base, SUPABASE_JWT_SECRET: "short" })).toMatch(/at least 32/);
    expect(fails({ ...base, SUPABASE_JWT_KEYS: "{not json" })).toMatch(/SUPABASE_JWT_KEYS/);
    expect(fails({ ...base, SUPABASE_JWT_KEYS: JSON.stringify([{ alg: "none", key: "x" }]) })).toMatch(/SUPABASE_JWT_KEYS/);
    expect(fails({ ...base, PORT: "abc" })).toMatch(/PORT/);
    expect(fails({ ...base, PORT: "70000" })).toMatch(/PORT/);
    expect(fails({ ...base, MAX_BODY_BYTES: "0" })).toMatch(/MAX_BODY_BYTES/);
    for (const env of [{ ...base, SUPABASE_JWT_SECRET: "short" }, { ...base, PORT: "abc" }]) {
      expect(fails(env)).not.toContain(base.DATABASE_URL);
    }
  });
});

describe("loadConfig: 종결 스위퍼 주기", () => {
  it("기본은 300초이고 0이면 끄며, 정수가 아니거나 범위(0~86400)를 벗어나면 시작을 거부한다", () => {
    expect(loadConfig(base).closureSweepIntervalSeconds).toBe(300);
    expect(loadConfig({ ...base, CLOSURE_SWEEP_INTERVAL_SECONDS: "60" }).closureSweepIntervalSeconds).toBe(60);
    expect(loadConfig({ ...base, CLOSURE_SWEEP_INTERVAL_SECONDS: "0" }).closureSweepIntervalSeconds).toBe(0);
    for (const bad of ["-1", "1.5", "abc", "86401"]) {
      expect(() => loadConfig({ ...base, CLOSURE_SWEEP_INTERVAL_SECONDS: bad }), bad).toThrow(/CLOSURE_SWEEP_INTERVAL_SECONDS/);
    }
  });

  it("CORS 허용 오리진은 기본이 빈 목록이고, 쉼표로 구분한 정확한 오리진만 받으며 와일드카드·경로·http 외 형식·중복은 거부한다", () => {
    expect(loadConfig(base).allowedOrigins).toEqual([]);
    expect(loadConfig({ ...base, CORS_ALLOWED_ORIGINS: "" }).allowedOrigins).toEqual([]);
    expect(loadConfig({ ...base, CORS_ALLOWED_ORIGINS: " https://app.example.com , http://localhost:5173 " }).allowedOrigins).toEqual(["https://app.example.com", "http://localhost:5173"]);
    for (const bad of ["*", "https://*.example.com", "https://app.example.com/", "https://app.example.com/path", "ftp://app.example.com", "app.example.com", "https://a.test,https://a.test", "null"]) {
      expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: bad }), bad).toThrow(/CORS_ALLOWED_ORIGINS/);
    }
  });
});

describe("loadConfig: DB 쿼리 시간 제한", () => {
  it("기본은 10초(요청 제한 15초보다 짧다)이고, 100~120000ms 정수만 받으며 0(무제한)을 포함해 범위 밖은 시작을 거부한다", () => {
    expect(loadConfig(base).statementTimeoutMs).toBe(10_000);
    expect(loadConfig({ ...base, DB_STATEMENT_TIMEOUT_MS: "2500" }).statementTimeoutMs).toBe(2500);
    for (const bad of ["0", "99", "120001", "1.5", "abc", "-1"]) {
      expect(() => loadConfig({ ...base, DB_STATEMENT_TIMEOUT_MS: bad }), bad).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
    }
  });
});

describe("loadConfig: YES24 도서 검색 연동", () => {
  it("주소와 키를 함께 줄 때만 켜지고(없으면 미설정), 운영 주소는 https여야 하며(로컬 개발은 http 허용), 제한 시간은 500~30000ms(기본 5000)이다", () => {
    expect(loadConfig(base).yes24).toBeUndefined();
    const on = loadConfig({ ...base, YES24_BOOK_SEARCH_URL: "https://book-gateway.example.com/search", YES24_API_KEY: "key-123" });
    expect(on.yes24).toEqual({ url: "https://book-gateway.example.com/search", apiKey: "key-123", timeoutMs: 5000 });
    expect(loadConfig({ ...base, YES24_BOOK_SEARCH_URL: "http://127.0.0.1:9999/search", YES24_API_KEY: "k", YES24_TIMEOUT_MS: "800" }).yes24).toEqual({ url: "http://127.0.0.1:9999/search", apiKey: "k", timeoutMs: 800 });
    expect(loadConfig({ ...base, YES24_BOOK_SEARCH_URL: "http://localhost:9/s", YES24_API_KEY: "k" }).yes24?.url).toBe("http://localhost:9/s");
  });

  it("주소만 있거나 키만 있거나, 운영 주소가 http이거나, URL·제한 시간이 잘못되면 시작을 거부하고 오류에 키·주소 값을 싣지 않는다", () => {
    const fails = (env: Record<string, string | undefined>) => {
      try {
        loadConfig(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("should fail");
    };
    expect(fails({ ...base, YES24_BOOK_SEARCH_URL: "https://x.example.com/s" })).toMatch(/YES24_API_KEY/);
    expect(fails({ ...base, YES24_API_KEY: "secret-key-xyz" })).toMatch(/YES24_BOOK_SEARCH_URL/);
    expect(fails({ ...base, YES24_BOOK_SEARCH_URL: "http://book.example.com/s", YES24_API_KEY: "secret-key-xyz" })).toMatch(/https/);
    expect(fails({ ...base, YES24_BOOK_SEARCH_URL: "not a url", YES24_API_KEY: "secret-key-xyz" })).toMatch(/YES24_BOOK_SEARCH_URL/);
    expect(fails({ ...base, YES24_BOOK_SEARCH_URL: "https://x.example.com/s", YES24_API_KEY: "k", YES24_TIMEOUT_MS: "100" })).toMatch(/YES24_TIMEOUT_MS/);
    for (const env of [{ ...base, YES24_API_KEY: "secret-key-xyz" }, { ...base, YES24_BOOK_SEARCH_URL: "http://book.example.com/s", YES24_API_KEY: "secret-key-xyz" }]) {
      expect(fails(env)).not.toContain("secret-key-xyz");
    }
  });
});

describe("loadConfig: 플랫폼 운영자 계정(서점 재사용 승인)", () => {
  const A = "11111111-0000-4000-8000-0000000000a9";
  const B = "11111111-0000-4000-8000-0000000000b9";

  it("PLATFORM_ADMIN_USER_IDS의 사용자 UUID 목록을 받고(공백 허용, 대소문자 무시), 없으면 빈 목록이다 — 운영자가 없으면 승인할 사람이 없다", () => {
    expect(loadConfig(base).platformAdminUserIds).toEqual([]);
    expect(loadConfig({ ...base, PLATFORM_ADMIN_USER_IDS: "" }).platformAdminUserIds).toEqual([]);
    expect(loadConfig({ ...base, PLATFORM_ADMIN_USER_IDS: ` ${A.toUpperCase()} , ${B}` }).platformAdminUserIds).toEqual([A, B]);
  });

  it("UUID가 아니거나 중복이면 시작을 거부하고 오류에 값을 싣지 않는다", () => {
    for (const bad of ["not-a-uuid", `${A},${A}`, `${A},`, "*"]) {
      let message = "";
      try {
        loadConfig({ ...base, PLATFORM_ADMIN_USER_IDS: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, bad).toMatch(/PLATFORM_ADMIN_USER_IDS/);
      expect(message, bad).not.toContain("not-a-uuid");
    }
  });
});
