import { describe, expect, it } from "vitest";
import { verifyJwt, type JwtKey } from "../../src/auth/jwt";
import { AppError } from "../../src/errors/AppError";
import { createEcKeyPair, createRsaKeyPair, encodeJwt, signEs256, signHs256, signRs256 } from "../helpers/jwtSign";

const NOW = new Date("2026-03-04T07:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const USER = "11111111-0000-4000-8000-000000000001";
const SECRET = "test-only-hs256-secret-0123456789abcdef";
const ec = createEcKeyPair();
const rsa = createRsaKeyPair();
const other = createEcKeyPair();

const keys: JwtKey[] = [
  { kid: "hs", alg: "HS256", key: SECRET },
  { kid: "ec", alg: "ES256", key: ec.publicJwk },
  { kid: "rsa", alg: "RS256", key: rsa.publicJwk },
];
const options = { keys, audience: "authenticated", now: () => NOW };
const claims = (extra: Record<string, unknown> = {}) => ({ sub: USER, aud: "authenticated", exp: NOW_SEC + 3600, iat: NOW_SEC - 10, role: "authenticated", ...extra });
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : "NON_APP_ERROR";
  }
};

describe("verifyJwt: Supabase 액세스 JWT 검증 (T2, ST-A08)", () => {
  it("HS256·ES256·RS256으로 서명된 유효한 토큰의 클레임을 돌려준다 (kid로 키 선택)", () => {
    expect(verifyJwt(signHs256(claims(), SECRET, { kid: "hs" }), options)).toMatchObject({ sub: USER, role: "authenticated" });
    expect(verifyJwt(signEs256(claims(), ec, { kid: "ec" }), options).sub).toBe(USER);
    expect(verifyJwt(signRs256(claims(), rsa, { kid: "rsa" }), options).sub).toBe(USER);
    // kid가 없으면 같은 알고리즘의 키를 모두 시도한다
    expect(verifyJwt(signHs256(claims(), SECRET), options).sub).toBe(USER);
  });

  it("위조·변조·만료 등 모든 실패는 이유를 구별할 수 없는 같은 UNAUTHENTICATED 401이다", () => {
    const good = signHs256(claims(), SECRET, { kid: "hs" });
    const [h, p, s] = good.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify(claims({ sub: "22222222-0000-4000-8000-000000000001" }))).toString("base64url");
    const cases: Record<string, string> = {
      "변조된 본문": `${h}.${tamperedPayload}.${s}`,
      "다른 비밀키": signHs256(claims(), "another-secret-another-secret-123456", { kid: "hs" }),
      "다른 EC 키로 서명": signEs256(claims(), other, { kid: "ec" }),
      "만료": signHs256(claims({ exp: NOW_SEC - 60 }), SECRET, { kid: "hs" }),
      "아직 유효하지 않음(nbf)": signHs256(claims({ nbf: NOW_SEC + 600 }), SECRET, { kid: "hs" }),
      "다른 aud": signHs256(claims({ aud: "anon" }), SECRET, { kid: "hs" }),
      "exp 없음": signHs256((({ exp: _e, ...rest }) => rest)(claims()), SECRET, { kid: "hs" }),
      "sub가 UUID가 아님": signHs256(claims({ sub: "owner-1" }), SECRET, { kid: "hs" }),
      "sub 없음": signHs256((({ sub: _s, ...rest }) => rest)(claims()), SECRET, { kid: "hs" }),
      "alg none": encodeJwt({ alg: "none", typ: "JWT" }, claims(), () => ""),
      "알 수 없는 alg": encodeJwt({ alg: "HS512", typ: "JWT" }, claims(), () => Buffer.from("x")),
      "알 수 없는 kid": signHs256(claims(), SECRET, { kid: "ghost" }),
      "지원하지 않는 crit 헤더": signHs256(claims(), SECRET, { kid: "hs", crit: ["exp"] }),
      "두 조각": `${h}.${p}`,
      "빈 문자열": "",
      "서명이 비어 있음": `${h}.${p}.`,
      "깨진 base64": "###.###.###",
      "너무 긴 토큰": `${h}.${Buffer.from("x".repeat(20_000)).toString("base64url")}.${s}`,
    };
    for (const [name, token] of Object.entries(cases)) {
      expect(codeOf(() => verifyJwt(token, options)), name).toBe("UNAUTHENTICATED");
    }
  });

  it("알고리즘 혼동 공격을 막는다: 공개 키를 HMAC 비밀로 서명한 HS256 토큰은 RS256·ES256 키로 검증되지 않는다", () => {
    const confused = signHs256(claims(), rsa.publicPem, { kid: "rsa" });
    const confusedEc = signHs256(claims(), ec.publicPem, { kid: "ec" });

    expect(codeOf(() => verifyJwt(confused, options))).toBe("UNAUTHENTICATED");
    expect(codeOf(() => verifyJwt(confusedEc, options))).toBe("UNAUTHENTICATED");
    // HS256 키가 구성되지 않았다면 어떤 HS256 토큰도 통과할 수 없다
    const asymmetricOnly = { ...options, keys: keys.filter((k) => k.alg !== "HS256") };
    expect(codeOf(() => verifyJwt(signHs256(claims(), SECRET), asymmetricOnly))).toBe("UNAUTHENTICATED");
  });

  it("시계 허용 오차(기본 5초) 안의 만료는 허용하고 그 밖은 거부하며, 발급자가 구성되면 일치해야 한다", () => {
    const withExp = (exp: number) => signHs256(claims({ exp }), SECRET, { kid: "hs" });

    expect(codeOf(() => verifyJwt(withExp(NOW_SEC - 3), options))).toBeUndefined();
    expect(codeOf(() => verifyJwt(withExp(NOW_SEC - 6), options))).toBe("UNAUTHENTICATED");
    expect(codeOf(() => verifyJwt(withExp(NOW_SEC - 3), { ...options, clockSkewSeconds: 0 }))).toBe("UNAUTHENTICATED");
    const withIss = signHs256(claims({ iss: "https://project.supabase.co/auth/v1" }), SECRET, { kid: "hs" });
    expect(codeOf(() => verifyJwt(withIss, { ...options, issuer: "https://project.supabase.co/auth/v1" }))).toBeUndefined();
    expect(codeOf(() => verifyJwt(withIss, { ...options, issuer: "https://evil.example/auth/v1" }))).toBe("UNAUTHENTICATED");
    expect(codeOf(() => verifyJwt(signHs256(claims(), SECRET, { kid: "hs" }), { ...options, issuer: "https://project.supabase.co/auth/v1" }))).toBe("UNAUTHENTICATED"); // iss 없음
  });
});
