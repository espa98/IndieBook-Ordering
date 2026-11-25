import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";

/** 존재하지 않는 대상을 가리키는 UUID(형식은 맞다) */
export const MISSING = "0a000000-0000-4000-8000-0000000000ff";
export const SPECS = ["../../openapi/ordering.yaml", "../../openapi/ordering-http.yaml"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
export type Json = Record<string, any>;
export const specKey = (r: { method: string; template: string }) => `${r.method} /v1/tenants/{tenantId}${r.template}`;

/** 요청 스키마(참조를 푼 것)에서 형식상 유효한 최소 본문을 만든다: 필수 필드만, 정수는 최소값 이상, 시각은 과거 값, enum은 첫 값 */
export function sample(schema: Json, name = ""): unknown {
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "integer":
      return Math.max(1, schema.minimum ?? 1);
    case "boolean":
      return true;
    case "array":
      return [sample(schema.items ?? {}, name)];
    case "object": {
      const props: Json = schema.properties ?? {};
      const keys: string[] = schema.required ?? [];
      const picked = keys.length > 0 ? keys : schema.minProperties ? [Object.keys(props)[0]!] : [];
      return Object.fromEntries(picked.map((k) => [k, sample(props[k] ?? {}, k)]));
    }
    default:
      if (schema.format === "date-time") return "2026-03-04T06:00:00.000Z";
      if (schema.format === "date") return "2026-03-04";
      if (schema.format === "uuid") return MISSING;
      if (/Krw$/.test(name)) return "1000";
      return "x";
  }
}
export const sampleBody = (op: Json | undefined) => JSON.stringify(sample(op?.requestBody?.content?.["application/json"]?.schema ?? { type: "object" }));

export async function loadOperations() {
  const ops = new Map<string, Json>();
  for (const file of SPECS) {
    const spec = (await SwaggerParser.dereference(file)) as unknown as Json;
    for (const [path, item] of Object.entries<Json>(spec.paths)) for (const m of ["get", "post"]) if (item[m]) ops.set(`${m.toUpperCase()} ${path}`, item[m]);
  }
  return ops;
}
