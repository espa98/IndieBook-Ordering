import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../../src/http/app";
import { createHttpServer } from "../../src/http/server";
import { signHs256 } from "../helpers/jwtSign";
import { loadOperations, MISSING } from "../helpers/httpContract";

/**
 * 413(본문이 상한을 넘음)은 서버 계층(`src/http/server.ts`)이 본문을 읽는 단계에서 내므로 앱(인증·경로 확인)보다 앞서고 DB가 필요 없다.
 * 모든 경로에서 같은 413이고, 인증 여부·경로 존재 여부로 응답이 달라지지 않으며(경로 탐색 방지), 명세가 그 상태를 선언하는지 확인한다.
 */
const SECRET = "payload-too-large-secret-0123456789abcdef";
const MAX = 4 * 1024; // 시험용 상한(바이트)
let server: Server;
let base: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  app = createApp({
    pool: { connect: () => Promise.reject(new Error("no database in this test")) } as never,
    jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" },
  });
  server = createHttpServer(app, { maxBodyBytes: MAX });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const token = () => {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: "11111111-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
};
const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
/** 계정 범위 경로(`/v1/stores` 등)는 서점 접두어가 없다. 명세의 키도 그에 맞춘다 */
const keyOf = (r: { method: string; scope: "tenant" | "account"; template: string }) => `${r.method} ${r.scope === "account" ? "/v1" : "/v1/tenants/{tenantId}"}${r.template}`;
const pathOf = (r: { scope: "tenant" | "account"; template: string }) =>
  `${r.scope === "account" ? "/v1" : `/v1/tenants/${TENANT}`}${r.template}`.replace(/\{code\}/g, "missing-code").replace(/\{[^}]+\}/g, MISSING);
async function post(path: string, options: { auth?: "valid" | "forged" | "none"; bytes: number }) {
  const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": "k-1" };
  if (options.auth === "valid") headers.authorization = `Bearer ${token()}`;
  if (options.auth === "forged") headers.authorization = "Bearer not.a.jwt";
  const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify({ pad: "x".repeat(options.bytes) }) });
  return { status: response.status, json: await response.json().catch(() => undefined) };
}

describe("413 PAYLOAD_TOO_LARGE: 모든 경로에서 같고, 인증·경로 존재 여부와 무관하며, 명세가 선언한다", () => {
  it("상한을 넘는 본문은 모든 POST 경로에서 413이고 본문이 ErrorBody(PAYLOAD_TOO_LARGE)이며, 상한 이하는 413이 아니다", async () => {
    const posts = app.routes.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(60);
    const problems: string[] = [];
    for (const r of posts) {
      const over = await post(pathOf(r), { auth: "valid", bytes: MAX + 1 });
      if (over.status !== 413 || over.json?.error?.code !== "PAYLOAD_TOO_LARGE") problems.push(`${keyOf(r)}: 상한 초과 -> ${over.status} ${JSON.stringify(over.json)}`);
      const under = await post(pathOf(r), { auth: "valid", bytes: 100 });
      if (under.status === 413) problems.push(`${keyOf(r)}: 상한 이하인데 413`);
    }
    expect(problems).toEqual([]);
  });

  it("토큰이 없거나 위조되었거나 존재하지 않는 경로여도 상한을 넘는 본문은 같은 413이다 (응답으로 경로·인증 상태를 알 수 없다)", async () => {
    const existing = pathOf(app.routes.find((r) => r.method === "POST")!);
    const results = [
      await post(existing, { auth: "valid", bytes: MAX + 1 }),
      await post(existing, { auth: "none", bytes: MAX + 1 }),
      await post(existing, { auth: "forged", bytes: MAX + 1 }),
      await post("/v1/tenants/not-a-uuid/no-such-route", { auth: "none", bytes: MAX + 1 }),
      await post("/no/such/path", { auth: "valid", bytes: MAX + 1 }),
    ];
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([413]));
    expect(new Set(results.map((r) => JSON.stringify(r.json)))).toEqual(new Set([JSON.stringify(results[0]!.json)]));
  });

  it("명세가 본문이 있는 모든 POST 경로에 413을 선언하고 응답 본문이 ErrorBody를 따른다", async () => {
    const ops = await loadOperations();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const problems: string[] = [];
    for (const r of app.routes.filter((x) => x.method === "POST")) {
      const key = keyOf(r);
      const declared = ops.get(key)?.responses?.["413"]?.content?.["application/json"]?.schema;
      if (!declared) {
        problems.push(`${key}: 명세가 413을 선언하지 않음`);
        continue;
      }
      const real = await post(pathOf(r), { auth: "valid", bytes: MAX + 1 });
      if (!ajv.validate(declared, real.json)) problems.push(`${key}: ${ajv.errorsText()}`);
    }
    expect(problems).toEqual([]);
  });

  it("상한 경계: 본문이 정확히 상한이면 413이 아니고 1바이트 넘으면 413이다 (off-by-one 없음)", async () => {
    const path = pathOf(app.routes.find((r) => r.method === "POST")!);
    const overhead = Buffer.byteLength(JSON.stringify({ pad: "" })); // {"pad":""}
    const exact = JSON.stringify({ pad: "x".repeat(MAX - overhead) });
    expect(Buffer.byteLength(exact)).toBe(MAX);
    const send = async (body: string) => (await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "idempotency-key": "k-1" }, body })).status;

    expect(await send(exact)).not.toBe(413);
    expect(await send(exact + " ")).toBe(413); // 공백 1바이트를 더하면 상한을 넘는다
  });
});

