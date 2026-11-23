import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";

const SPEC_PATH = fileURLToPath(new URL("../../openapi/ordering.yaml", import.meta.url));

type Spec = {
  openapi: string;
  security?: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any>; securitySchemes: Record<string, any> };
};

const load = () => parse(readFileSync(SPEC_PATH, "utf8")) as Spec;

const BASE = "/v1/tenants/{tenantId}";

describe("openapi/ordering.yaml", () => {
  it("유효한 OpenAPI 3.1 문서이다 (참조 해석 포함)", async () => {
    expect(load().openapi).toMatch(/^3\.1\./);
    await expect(SwaggerParser.validate(SPEC_PATH)).resolves.toBeDefined();
  });

  it("구현한 4개 엔드포인트만 정의하고, 문서에 있으나 미구현인 경로는 넣지 않는다", () => {
    const spec = load();
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(operations.sort()).toEqual(
      [
        `GET ${BASE}/orders`,
        `POST ${BASE}/orders`,
        `GET ${BASE}/orders/{orderId}`,
        `POST ${BASE}/orders/{orderId}/confirm`,
      ].sort(),
    );
  });

  it("전역으로 Bearer JWT 인증을 요구하고, 쓰기(POST)는 Idempotency-Key 헤더를 필수로 받는다", async () => {
    // $ref(재사용 파라미터)를 해석한 문서로 확인한다
    const spec = (await SwaggerParser.dereference(SPEC_PATH)) as unknown as Spec;

    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);

    for (const path of [`${BASE}/orders`, `${BASE}/orders/{orderId}/confirm`]) {
      const params: any[] = spec.paths[path]!.post.parameters ?? [];
      const key = params.find((p) => p.name === "Idempotency-Key");
      expect(key, `${path} POST에 Idempotency-Key`).toMatchObject({
        in: "header",
        required: true,
      });
    }
  });
});
