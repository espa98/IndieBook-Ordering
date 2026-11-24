import { describe, it, expect } from "vitest";
import { ALLOWED_TEMPLATE_VARIABLES, renderTemplate } from "../../src/catalog/messageTemplate";
import type { TemplateVersion } from "../../src/catalog/messageTemplate";
import { publishTemplateVersion } from "../../src/catalog/publishTemplateVersion";
import type { PublishTemplateVersionRequest } from "../../src/catalog/publishTemplateVersion";
import { AppError } from "../../src/errors/AppError";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
};

function templateScene() {
  const versions: TemplateVersion[] = [];
  const deps = {
    templateVersions: {
      list: (t: string, key: string) => versions.filter((v) => v.tenantId === t && v.key === key),
      save: (v: TemplateVersion) => void versions.push(v),
    },
    managementDelegations: { isDelegated: (t: string, u: string) => t === "tenant-a" && u === "staff-delegated" },
    idempotency: createIdempotencyStore(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const publishRequest = (extra: Partial<PublishTemplateVersionRequest> = {}): PublishTemplateVersionRequest => ({
    tenantId: "tenant-a",
    key: "ARRIVAL_NOTICE",
    body: "{{displayNumber}}번 주문 {{bookTitle}} {{securedQuantity}}권이 도착했습니다.",
    expectedVersion: 0,
    actorRole: "OWNER",
    publishedBy: "owner-1",
    publishedAt: "2026-03-04T06:50:00.000Z",
    idempotencyKey: `tpl-${++seq}`,
    ...extra,
  });
  return { deps, versions, publishRequest };
}

describe("publishTemplateVersion: 안내 문구 템플릿 버전 (ST-B05, MSG-001~003)", () => {
  it("첫 발행은 v1이고, 문구를 바꾸면 v2가 추가되며 v1은 그대로 남아 이전 문구로 계속 렌더링할 수 있다", () => {
    const { deps, versions, publishRequest } = templateScene();

    const v1 = publishTemplateVersion(deps, publishRequest());
    const v2 = publishTemplateVersion(
      deps,
      publishRequest({ expectedVersion: 1, body: "{{bookTitle}} {{securedQuantity}}권 도착. 수령 부탁드립니다." }),
    );

    expect(v1).toMatchObject({ tenantId: "tenant-a", key: "ARRIVAL_NOTICE", version: 1, variables: ["displayNumber", "bookTitle", "securedQuantity"] });
    expect(v2).toMatchObject({ version: 2, variables: ["bookTitle", "securedQuantity"], publishedBy: "owner-1" });
    expect(versions).toEqual([v1, v2]); // 추가 전용, v1은 변경되지 않음
    const values = { displayNumber: "12", bookTitle: "책방의 오후", securedQuantity: "2" };
    expect(renderTemplate(v1, values)).toBe("12번 주문 책방의 오후 2권이 도착했습니다.");
    expect(renderTemplate(v2, values)).toBe("책방의 오후 2권 도착. 수령 부탁드립니다.");
  });

  it("허용되지 않은 변수(연락처 등)·닫히지 않은 자리표시자·빈 문구·긴 문구·형식이 틀린 키는 VALIDATION_ERROR이고 발행되지 않는다", () => {
    const { deps, versions, publishRequest } = templateScene();

    for (const bad of [
      { body: "{{customerPhone}}로 연락드립니다" },
      { body: "{{bookTitle" },
      { body: "{{ }}" },
      { body: "   " },
      { body: "가".repeat(1001) },
      { key: "bad key" },
      { publishedBy: "" },
      { publishedAt: "2999-01-01T00:00:00.000Z" },
    ]) {
      expect(codeOf(() => publishTemplateVersion(deps, publishRequest(bad))), JSON.stringify(bad).slice(0, 40)).toBe("VALIDATION_ERROR");
    }
    expect(versions).toEqual([]);
    expect(ALLOWED_TEMPLATE_VARIABLES).not.toContain("customerPhone");
    expect(ALLOWED_TEMPLATE_VARIABLES).toContain("bookTitle");
  });

  it("최신 버전과 expectedVersion이 다르면 VERSION_CONFLICT 409이고, 위임받지 않은 직원은 FORBIDDEN, 위임받은 직원은 발행할 수 있다", () => {
    const { deps, publishRequest } = templateScene();
    publishTemplateVersion(deps, publishRequest());

    expect(codeOf(() => publishTemplateVersion(deps, publishRequest({ expectedVersion: 0 })))).toBe("VERSION_CONFLICT"); // 동시 편집
    expect(codeOf(() => publishTemplateVersion(deps, publishRequest({ expectedVersion: 5 })))).toBe("VERSION_CONFLICT");
    expect(codeOf(() => publishTemplateVersion(deps, publishRequest({ expectedVersion: 1, actorRole: "STAFF", publishedBy: "staff-other" })))).toBe("FORBIDDEN");
    expect(codeOf(() => publishTemplateVersion(deps, publishRequest({ expectedVersion: 1, actorRole: "STAFF", publishedBy: "staff-delegated" })))).toBeUndefined();
    // 다른 키·다른 테넌트는 독립된 버전 계열이다
    expect(codeOf(() => publishTemplateVersion(deps, publishRequest({ key: "DELAY_NOTICE" })))).toBeUndefined();
    expect(codeOf(() => publishTemplateVersion(deps, publishRequest({ tenantId: "tenant-b" })))).toBeUndefined();
  });

  it("렌더링에 필요한 값이 빠졌거나 허용 변수가 아닌 값이 비어 있으면 VALIDATION_ERROR이고, 남는 값은 무시한다", () => {
    const { deps, publishRequest } = templateScene();
    const v1 = publishTemplateVersion(deps, publishRequest({ body: "{{bookTitle}} {{securedQuantity}}권" }));

    expect(codeOf(() => renderTemplate(v1, { bookTitle: "책" }))).toBe("VALIDATION_ERROR");
    expect(renderTemplate(v1, { bookTitle: "책", securedQuantity: "1", unused: "x" })).toBe("책 1권");
  });
});
