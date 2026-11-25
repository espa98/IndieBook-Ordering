import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../../src/http/server";

const ALLOWED = "https://app.bookflow.test";
let server: Server;
let base: string;
let reached = 0;

beforeAll(async () => {
  server = createHttpServer(
    async () => {
      reached += 1;
      return { status: 200, body: { data: "ok" } };
    },
    { allowedOrigins: [ALLOWED] },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("CORS (E9): 허용 오리진 목록", () => {
  it("허용된 오리진의 요청에만 CORS 응답 헤더를 붙이고(`*`·자격 증명 없음), 다른 오리진·오리진 없는 요청에는 붙이지 않는다", async () => {
    const allowed = await fetch(`${base}/v1/x`, { headers: { origin: ALLOWED } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(allowed.headers.get("vary")).toContain("Origin");
    expect(allowed.headers.get("access-control-expose-headers")).toContain("x-request-id");
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();

    for (const origin of ["https://evil.test", "https://app.bookflow.test.evil.test", "http://app.bookflow.test", "null"]) {
      const res = await fetch(`${base}/v1/x`, { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
    expect((await fetch(`${base}/v1/x`)).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("허용된 오리진의 프리플라이트는 인증 없이 204로 허용 메서드·헤더를 알리고(앱까지 가지 않는다), 허용되지 않은 오리진의 프리플라이트는 403이다", async () => {
    const before = reached;
    const ok = await fetch(`${base}/v1/tenants/t/orders`, {
      method: "OPTIONS",
      headers: { origin: ALLOWED, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, idempotency-key" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(ok.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(ok.headers.get("access-control-allow-headers")?.toLowerCase()).toBe("authorization, content-type, idempotency-key");
    expect(ok.headers.get("access-control-max-age")).toBe("600");
    expect(await ok.text()).toBe("");

    const denied = await fetch(`${base}/v1/tenants/t/orders`, { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(reached).toBe(before);
  });
});
