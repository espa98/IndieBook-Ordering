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
});
