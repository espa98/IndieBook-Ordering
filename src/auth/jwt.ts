import { createHmac, createPublicKey, createVerify, timingSafeEqual, type KeyObject } from "node:crypto";
import { AppError } from "../errors/AppError";

/** 서버가 신뢰하는 서명 키. 알고리즘을 키에 못 박아, 토큰 헤더가 알고리즘을 고르지 못하게 한다(알고리즘 혼동 방지). */
export type JwtKey =
  | { kid?: string; alg: "HS256"; /** 프로젝트 JWT 비밀(서버만 안다) */ key: string }
  | { kid?: string; alg: "RS256" | "ES256"; /** 공개 키(JWK 또는 PEM) */ key: JsonWebKey | string };

export type JwtVerifyOptions = {
  keys: readonly JwtKey[];
  /** 기대하는 aud. Supabase 액세스 토큰은 "authenticated" */
  audience: string;
  /** 구성하면 iss가 같아야 한다 */
  issuer?: string;
  now?: () => Date;
  /** exp·nbf 시계 허용 오차(초). 기본 5 */
  clockSkewSeconds?: number;
};

export type JwtClaims = {
  sub: string;
  exp: number;
  aud: string | string[];
  [claim: string]: unknown;
};

const MAX_TOKEN_LENGTH = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED = new Set(["HS256", "RS256", "ES256"]);

const reject = (): never => {
  // 어떤 이유로 실패했는지는 호출자에게 알리지 않는다
  throw new AppError("UNAUTHENTICATED");
};

function decodeJson(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return reject();
    return value as Record<string, unknown>;
  } catch {
    return reject();
  }
}

function toPublicKey(key: JsonWebKey | string): KeyObject {
  try {
    return typeof key === "string" ? createPublicKey(key) : createPublicKey({ key, format: "jwk" });
  } catch {
    return reject();
  }
}

function signatureMatches(key: JwtKey, signingInput: string, signature: Buffer): boolean {
  if (key.alg === "HS256") {
    const expected = createHmac("sha256", key.key).update(signingInput).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }
  const verifier = createVerify("sha256").update(signingInput);
  const publicKey = toPublicKey(key.key);
  // JWS의 ES256 서명은 DER가 아니라 r||s(IEEE P1363) 형식이다
  return key.alg === "ES256"
    ? verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
    : verifier.verify(publicKey, signature);
}

/**
 * Supabase 액세스 JWT를 검증한다 (T2). 서명·`exp`·`nbf`·`aud`(·`iss`)와 `sub`가 UUID인지 확인하며,
 * 어떤 실패든 같은 UNAUTHENTICATED로 거부한다. 헤더의 `alg`는 구성된 키의 알고리즘과 같아야 하고,
 * `none`·미지원 알고리즘·`crit` 헤더는 거부한다. 서버가 아는 키 외에는 신뢰하지 않는다.
 */
export function verifyJwt(token: string, options: JwtVerifyOptions): JwtClaims {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return reject();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return reject();
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  if (typeof header.alg !== "string" || !SUPPORTED.has(header.alg) || "crit" in header) return reject();
  if (header.kid !== undefined && typeof header.kid !== "string") return reject();

  // 알고리즘이 같고 kid가 맞는(토큰에 kid가 없으면 모든) 구성 키만 후보다
  const candidates = options.keys.filter((k) => k.alg === header.alg && (header.kid === undefined || k.kid === header.kid));
  if (candidates.length === 0) return reject();
  const signature = Buffer.from(signaturePart, "base64url");
  const signingInput = `${headerPart}.${payloadPart}`;
  if (!candidates.some((k) => signatureMatches(k, signingInput, signature))) return reject();

  const claims = decodeJson(payloadPart);
  const nowSec = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  const skew = options.clockSkewSeconds ?? 5;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + skew <= nowSec) return reject();
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > nowSec)) return reject();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) return reject();
  if (options.issuer !== undefined && claims.iss !== options.issuer) return reject();
  if (typeof claims.sub !== "string" || !UUID.test(claims.sub)) return reject();
  return claims as JwtClaims;
}
