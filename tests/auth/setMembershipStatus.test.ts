import { describe, it, expect } from "vitest";
import type { Membership } from "../../src/auth/authorizeTenantAccess";
import { resolvePrincipal } from "../../src/auth/principal";
import { setMembershipStatus } from "../../src/auth/setMembershipStatus";
import type {
  MembershipChange,
  SetMembershipStatusRequest,
} from "../../src/auth/setMembershipStatus";
import { AppError } from "../../src/errors/AppError";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";

const NOW = new Date("2026-03-04T07:00:00.000Z");
const FUTURE = "2026-03-04T08:00:00.000Z";

function statusScene(extraOwner = false) {
  const members: Membership[] = [
    { userId: "owner-1", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
    { userId: "staff-1", tenantId: "tenant-a", role: "STAFF", status: "ACTIVE" },
    { userId: "owner-b", tenantId: "tenant-b", role: "OWNER", status: "ACTIVE" },
    ...(extraOwner ? [{ userId: "owner-2", tenantId: "tenant-a", role: "OWNER" as const, status: "ACTIVE" as const }] : []),
  ];
  const changes: MembershipChange[] = [];
  const memberships = {
    find: (userId: string, tenantId: string) => members.find((m) => m.userId === userId && m.tenantId === tenantId),
    listByTenant: (tenantId: string) => members.filter((m) => m.tenantId === tenantId),
    save: (m: Membership) => {
      const i = members.findIndex((x) => x.userId === m.userId && x.tenantId === m.tenantId);
      if (i >= 0) members[i] = m;
      else members.push(m);
    },
  };
  const deps = {
    memberships,
    membershipChanges: { list: (t: string) => changes.filter((c) => c.tenantId === t), save: (c: MembershipChange) => void changes.push(c) },
    idempotency: createIdempotencyStore(),
    now: () => NOW,
  };
  let seq = 0;
  const statusRequest = (extra: Partial<SetMembershipStatusRequest> = {}): SetMembershipStatusRequest => ({
    tenantId: "tenant-a",
    targetUserId: "staff-1",
    status: "INACTIVE",
    actorRole: "OWNER",
    changedBy: "owner-1",
    idempotencyKey: `sms-${++seq}`,
    ...extra,
  });
  return { deps, members, changes, statusRequest };
}

describe("setMembershipStatus: 직원 비활성화·복구 (ST-A05, BR-T06)", () => {
  it("Owner가 직원을 비활성화하면 즉시 접근이 차단되고 변경 기록이 남으며, 복구하면 다시 접근할 수 있다", () => {
    const { deps, changes, statusRequest } = statusScene();
    const identity = { userId: "staff-1", tenantId: "tenant-a", sessionExpiresAt: FUTURE };
    const resolve = () => resolvePrincipal({ memberships: deps.memberships, now: () => NOW }, identity);
    expect(resolve()).toMatchObject({ role: "STAFF" });

    const change = setMembershipStatus(deps, statusRequest());

    expect(change).toEqual({
      id: expect.any(String),
      tenantId: "tenant-a",
      userId: "staff-1",
      from: "ACTIVE",
      to: "INACTIVE",
      changedBy: "owner-1",
      changedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(changes).toEqual([change]);
    expect(() => resolve()).toThrow(AppError); // 같은 세션이 아직 유효해도 즉시 차단

    setMembershipStatus(deps, statusRequest({ status: "ACTIVE" }));
    expect(resolve()).toMatchObject({ role: "STAFF" });
    expect(changes.map((c) => c.to)).toEqual(["INACTIVE", "ACTIVE"]);
  });

  it("Staff는 변경할 수 없고(FORBIDDEN), 대상이 없거나 다른 테넌트면 NOT_FOUND, 이미 같은 상태이거나 잘못된 값이면 거부하며 아무것도 바뀌지 않는다", () => {
    const { deps, members, changes, statusRequest } = statusScene();
    const codeOf = (extra: Partial<SetMembershipStatusRequest>) => {
      try {
        setMembershipStatus(deps, statusRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ actorRole: "STAFF" })).toBe("FORBIDDEN");
    expect(codeOf({ targetUserId: "no-such" })).toBe("NOT_FOUND");
    expect(codeOf({ targetUserId: "owner-b" })).toBe("NOT_FOUND"); // 다른 테넌트의 Owner
    expect(codeOf({ status: "SUSPENDED" as never })).toBe("VALIDATION_ERROR");
    expect(codeOf({ changedBy: "" })).toBe("VALIDATION_ERROR");
    expect(codeOf({ status: "ACTIVE" })).toBe("BUSINESS_INVARIANT"); // 이미 ACTIVE
    expect(changes).toEqual([]);
    expect(members.every((m) => m.status === "ACTIVE")).toBe(true);
  });

  it("마지막 활성 Owner는 비활성화할 수 없고(BUSINESS_INVARIANT 422), 다른 활성 Owner가 있으면 가능하다", () => {
    const sole = statusScene();
    let code: string | undefined;
    try {
      setMembershipStatus(sole.deps, sole.statusRequest({ targetUserId: "owner-1" }));
    } catch (error) {
      code = (error as AppError).code;
    }
    expect(code).toBe("BUSINESS_INVARIANT");
    expect(sole.members.find((m) => m.userId === "owner-1")!.status).toBe("ACTIVE");

    const two = statusScene(true);
    setMembershipStatus(two.deps, two.statusRequest({ targetUserId: "owner-1", changedBy: "owner-2" }));
    expect(two.members.find((m) => m.userId === "owner-1")!.status).toBe("INACTIVE");
    // 이제 owner-2가 마지막 활성 Owner다
    expect(() =>
      setMembershipStatus(two.deps, two.statusRequest({ targetUserId: "owner-2", changedBy: "owner-2" })),
    ).toThrow(AppError);
  });
});
