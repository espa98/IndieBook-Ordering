import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import type { Membership } from "../../src/auth/authorizeTenantAccess";
import { createSystemPrincipal, resolvePrincipal } from "../../src/auth/principal";
import { createInMemoryMembershipRepository } from "../helpers/inMemoryMembershipRepository";

const NOW = new Date("2026-03-04T07:00:00.000Z");
const FUTURE = "2026-03-04T08:00:00.000Z";

function scene(status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const members = [
    { userId: "owner-1", tenantId: "tenant-a", role: "OWNER" as const, status: "ACTIVE" as const },
    { userId: "staff-1", tenantId: "tenant-a", role: "STAFF" as const, status },
  ];
  const memberships = createInMemoryMembershipRepository(members);
  return { memberships, members, deps: { memberships, now: () => NOW } };
}

describe("resolvePrincipal: 검증된 신원에서 서버가 역할을 도출 (ST-A05, ST-A08)", () => {
  it("활성 멤버십의 사용자·테넌트·역할로 USER 주체를 만든다 (역할은 요청이 아니라 멤버십에서 온다)", () => {
    const { deps } = scene();

    expect(resolvePrincipal(deps, { userId: "owner-1", tenantId: "tenant-a", sessionExpiresAt: FUTURE })).toEqual({
      kind: "USER",
      userId: "owner-1",
      tenantId: "tenant-a",
      role: "OWNER",
    });
    expect(resolvePrincipal(deps, { userId: "staff-1", tenantId: "tenant-a", sessionExpiresAt: FUTURE })).toMatchObject({
      role: "STAFF",
    });
  });
});

describe("resolvePrincipal: 거부 조건", () => {
  const codeOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return (error as AppError).code;
    }
  };

  it("만료되었거나 만료 시각이 잘못된 세션은 UNAUTHENTICATED 401이다 (ST-A08)", () => {
    const { deps } = scene();
    const resolve = (sessionExpiresAt: string) =>
      codeOf(() => resolvePrincipal(deps, { userId: "owner-1", tenantId: "tenant-a", sessionExpiresAt }));

    expect(resolve("2026-03-04T07:00:00.000Z")).toBe("UNAUTHENTICATED"); // 지금 = 만료
    expect(resolve("2026-03-04T06:59:59.000Z")).toBe("UNAUTHENTICATED");
    expect(resolve("not-a-date")).toBe("UNAUTHENTICATED");
    expect(resolve("")).toBe("UNAUTHENTICATED");
    expect(resolve(FUTURE)).toBeUndefined();
  });

  it("비활성 직원·다른 테넌트·비멤버는 모두 같은 FORBIDDEN 403이다", () => {
    const { deps } = scene("INACTIVE");
    const resolve = (userId: string, tenantId: string) =>
      codeOf(() => resolvePrincipal(deps, { userId, tenantId, sessionExpiresAt: FUTURE }));

    expect(resolve("staff-1", "tenant-a")).toBe("FORBIDDEN");
    expect(resolve("owner-1", "tenant-b")).toBe("FORBIDDEN");
    expect(resolve("stranger", "tenant-a")).toBe("FORBIDDEN");
  });

  it("직원을 비활성화하면 같은 신원의 다음 호출부터 즉시 차단된다 (ST-A05)", () => {
    const members: Membership[] = [{ userId: "staff-1", tenantId: "tenant-a", role: "STAFF", status: "ACTIVE" }];
    const deps = { memberships: createInMemoryMembershipRepository(members), now: () => NOW };
    const identity = { userId: "staff-1", tenantId: "tenant-a", sessionExpiresAt: FUTURE };

    expect(codeOf(() => resolvePrincipal(deps, identity))).toBeUndefined();
    members[0]!.status = "INACTIVE"; // 같은 세션 토큰이 아직 유효해도
    expect(codeOf(() => resolvePrincipal(deps, identity))).toBe("FORBIDDEN");
  });
});

describe("createSystemPrincipal", () => {
  it("서버 내부 업무용 SYSTEM 주체는 테넌트만 가진다", () => {
    expect(createSystemPrincipal("tenant-a")).toEqual({ kind: "SYSTEM", tenantId: "tenant-a" });
    expect(AppError).toBeDefined();
  });
});
