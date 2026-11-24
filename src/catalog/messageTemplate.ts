import { invalid } from "../procurement/validation";

/**
 * 안내 문구에 쓸 수 있는 변수. 고객 연락처·이름 같은 개인정보는 포함하지 않는다 (DEC-12 법률 검토 전).
 * 이 목록은 구현 해석이며 사용자 승인이 필요하다.
 */
export const ALLOWED_TEMPLATE_VARIABLES = [
  "displayNumber",
  "bookTitle",
  "orderedQuantity",
  "securedQuantity",
  "storeName",
  "expectedArrival",
] as const;

export const MAX_BODY_LENGTH = 1000;
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** 안내 문구 템플릿 버전 (추가 전용, ST-B05). 이전 버전은 바뀌지 않는다. */
export type TemplateVersion = {
  id: string;
  tenantId: string;
  key: string;
  version: number;
  body: string;
  variables: string[];
  publishedBy: string;
  publishedAt: string;
  recordedAt: string;
};

export type TemplateVersionRepository = {
  list(tenantId: string, key: string): TemplateVersion[];
  save(version: TemplateVersion): void;
};

/** 본문의 자리표시자 이름을 등장 순서대로(중복 없이) 돌려준다. 허용 변수만 쓰였는지, 괄호가 닫혔는지 검증한다. */
export function templateVariables(body: string): string[] {
  const names = [...body.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const leftover = body.replace(PLACEHOLDER, "");
  if (leftover.includes("{{") || leftover.includes("}}")) {
    invalid("body", "contains a malformed placeholder");
  }
  const unknown = names.filter((n) => !(ALLOWED_TEMPLATE_VARIABLES as readonly string[]).includes(n));
  if (unknown.length > 0) {
    invalid("body", `contains variables that are not allowed: ${[...new Set(unknown)].join(", ")}`);
  }
  return [...new Set(names)];
}

/** 값으로 자리표시자를 채운다. 필요한 값이 빠지면 거부한다. 템플릿 버전은 바꾸지 않는다. */
export function renderTemplate(version: Pick<TemplateVersion, "body">, values: Record<string, string>): string {
  return version.body.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];
    if (typeof value !== "string") {
      invalid("values", `missing value for ${name}`);
    }
    return value;
  });
}
