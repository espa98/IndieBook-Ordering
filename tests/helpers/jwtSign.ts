import { createHmac, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** 시험용 JWT 서명. 헤더·클레임을 마음대로 만들어 위조 사례도 재현한다 */
export function encodeJwt(header: Record<string, unknown>, claims: Record<string, unknown>, sign: (signingInput: string) => Buffer | string): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign(signingInput);
  return `${signingInput}.${typeof signature === "string" ? signature : b64url(signature)}`;
}

export function signHs256(claims: Record<string, unknown>, secret: string, header: Record<string, unknown> = {}): string {
  return encodeJwt({ alg: "HS256", typ: "JWT", ...header }, claims, (input) => createHmac("sha256", secret).update(input).digest());
}

export type TestKeyPair = { privateKey: KeyObject; publicJwk: JsonWebKey; publicPem: string };

export function createEcKeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicJwk: publicKey.export({ format: "jwk" }), publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

export function createRsaKeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, publicJwk: publicKey.export({ format: "jwk" }), publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

export function signEs256(claims: Record<string, unknown>, pair: TestKeyPair, header: Record<string, unknown> = {}): string {
  return encodeJwt({ alg: "ES256", typ: "JWT", ...header }, claims, (input) =>
    // JWS의 ES256 서명은 DER가 아니라 r||s(IEEE P1363) 형식이다
    createSign("sha256").update(input).sign({ key: pair.privateKey, dsaEncoding: "ieee-p1363" }),
  );
}

export function signRs256(claims: Record<string, unknown>, pair: TestKeyPair, header: Record<string, unknown> = {}): string {
  return encodeJwt({ alg: "RS256", typ: "JWT", ...header }, claims, (input) => createSign("sha256").update(input).sign(pair.privateKey));
}
