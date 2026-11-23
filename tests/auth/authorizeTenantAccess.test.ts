import { describe, it, expect, vi } from "vitest";
import { authorizeTenantAccess } from "../../src/auth/authorizeTenantAccess";
import { createInMemoryMembershipRepository } from "../helpers/inMemoryMembershipRepository";
import { thrown } from "../helpers/thrown";
import { AppError } from "../../src/errors/AppError";

describe("authorizeTenantAccess", () => {
  it("활성 Owner와 활성 Staff는 자기 테넌트에 접근할 수 있고 역할이 반환된다", () => {
    const memberships = createInMemoryMembershipRepository([
      { userId: "owner-1", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
      { userId: "staff-1", tenantId: "tenant-a", role: "STAFF", status: "ACTIVE" },
    ]);

    expect(
      authorizeTenantAccess(
        { memberships },
        { userId: "owner-1", tenantId: "tenant-a" },
      ),
    ).toEqual({ role: "OWNER" });
    expect(
      authorizeTenantAccess(
        { memberships },
        { userId: "staff-1", tenantId: "tenant-a" },
      ),
    ).toEqual({ role: "STAFF" });
  });

  it.each([
    ["어느 테넌트에도 속하지 않은 사용자", "stranger", "tenant-a"],
    ["다른 테넌트의 멤버가 이 테넌트에 접근", "owner-b", "tenant-a"],
    ["존재하지 않는 테넌트", "owner-1", "tenant-does-not-exist"],
    ["빈 tenantId", "owner-1", ""],
  ])("멤버가 아니면(%s) 모두 같은 FORBIDDEN이다", (_name, userId, tenantId) => {
    const memberships = createInMemoryMembershipRepository([
      { userId: "owner-1", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
      { userId: "owner-b", tenantId: "tenant-b", role: "OWNER", status: "ACTIVE" },
    ]);

    expect(() =>
      authorizeTenantAccess({ memberships }, { userId, tenantId }),
    ).toThrow(/^FORBIDDEN$/);
  });

  it.each(["OWNER", "STAFF"] as const)(
    "비활성 %s는 FORBIDDEN이다 (BR-T06: 비활성화 후 새 요청 차단)",
    (role) => {
      const memberships = createInMemoryMembershipRepository([
        { userId: "user-1", tenantId: "tenant-a", role, status: "INACTIVE" },
      ]);

      expect(() =>
        authorizeTenantAccess(
          { memberships },
          { userId: "user-1", tenantId: "tenant-a" },
        ),
      ).toThrow(/^FORBIDDEN$/);
    },
  );

  it("같은 사용자를 활성으로 되돌리면(ST-A05 복구) 다시 접근할 수 있다", () => {
    const repo = (status: "ACTIVE" | "INACTIVE") =>
      createInMemoryMembershipRepository([
        { userId: "staff-1", tenantId: "tenant-a", role: "STAFF", status },
      ]);
    const request = { userId: "staff-1", tenantId: "tenant-a" };

    expect(() =>
      authorizeTenantAccess({ memberships: repo("INACTIVE") }, request),
    ).toThrow(/^FORBIDDEN$/);
    expect(
      authorizeTenantAccess({ memberships: repo("ACTIVE") }, request),
    ).toEqual({ role: "STAFF" });
  });

  it.each([
    ["인증 없음(빈 userId)", "", "tenant-a", "UNAUTHENTICATED", 401],
    ["비멤버", "stranger", "tenant-a", "FORBIDDEN", 403],
    ["비활성 멤버", "ex-staff", "tenant-a", "FORBIDDEN", 403],
  ] as const)(
    "%s는 올바른 code·HTTP 상태의 AppError로 던진다",
    (_name, userId, tenantId, code, status) => {
      const memberships = createInMemoryMembershipRepository([
        { userId: "ex-staff", tenantId: "tenant-a", role: "STAFF", status: "INACTIVE" },
      ]);

      const error = thrown(() =>
        authorizeTenantAccess({ memberships }, { userId, tenantId }),
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
    },
  );

  it.each(["", "   ", null, undefined])(
    "userId가 비어 있거나 없으면(%j) UNAUTHENTICATED이고 membership을 조회하지 않는다",
    (userId) => {
      const find = vi.fn();
      const memberships = { find };

      expect(() =>
        authorizeTenantAccess(
          { memberships },
          { userId: userId as unknown as string, tenantId: "tenant-a" },
        ),
      ).toThrow(/^UNAUTHENTICATED$/);
      expect(find).not.toHaveBeenCalled();
    },
  );
});
