import { describe, it, expect } from "vitest";
import { acceptInvitation } from "../../src/auth/acceptInvitation";
import type { AcceptInvitationRequest } from "../../src/auth/acceptInvitation";
import type { Membership } from "../../src/auth/authorizeTenantAccess";
import { invitationStatus, inviteStaff } from "../../src/auth/inviteStaff";
import { resolvePrincipal } from "../../src/auth/principal";
import { AppError } from "../../src/errors/AppError";
import { invitationScene } from "../helpers/invitationFixtures";

const NOW = new Date("2026-03-04T07:00:00.000Z");

function acceptScene() {
  const s = invitationScene();
  const { token } = inviteStaff(s.deps, s.inviteRequest());
  const members: Membership[] = [
    { userId: "owner-1", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
  ];
  const memberships = {
    find: (userId: string, tenantId: string) => members.find((m) => m.userId === userId && m.tenantId === tenantId),
    save: (m: Membership) => void members.push(m),
  };
  const deps = { ...s.deps, memberships };
  let seq = 0;
  const acceptRequest = (extra: Partial<AcceptInvitationRequest> = {}): AcceptInvitationRequest => ({
    token,
    userId: "staff-9",
    verifiedEmail: "staff@example.com",
    idempotencyKey: `acc-${++seq}`,
    ...extra,
  });
  return { ...s, deps, members, token, acceptRequest };
}

describe("acceptInvitation: 초대 수락 (ST-A03)", () => {
  it("유효한 토큰과 확인된 이메일로 수락하면 활성 Staff 멤버십이 생기고 초대는 ACCEPTED가 되어 다시 쓸 수 없다", () => {
    const { deps, members, invitations, events, acceptRequest } = acceptScene();

    const membership = acceptInvitation(deps, acceptRequest());

    expect(membership).toEqual({ userId: "staff-9", tenantId: "tenant-a", role: "STAFF", status: "ACTIVE" });
    expect(members).toContainEqual(membership);
    expect(invitationStatus(invitations[0]!, events, NOW)).toBe("ACCEPTED");
    // 새 멤버십으로 주체를 도출할 수 있다
    expect(
      resolvePrincipal(
        { memberships: deps.memberships, now: () => NOW },
        { userId: "staff-9", tenantId: "tenant-a", sessionExpiresAt: "2026-03-04T08:00:00.000Z" },
      ),
    ).toMatchObject({ role: "STAFF" });
  });

  it("틀린 토큰·다른 이메일·만료·철회·재사용은 모두 같은 FORBIDDEN 403이고 멤버십은 생기지 않는다", () => {
    const { deps, members, events, invitations, acceptRequest } = acceptScene();
    const codeOf = (extra: Partial<AcceptInvitationRequest>) => {
      try {
        acceptInvitation(deps, acceptRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ token: "wrong-token" })).toBe("FORBIDDEN");
    expect(codeOf({ verifiedEmail: "someone@else.com" })).toBe("FORBIDDEN");
    expect(codeOf({ verifiedEmail: "" })).toBe("FORBIDDEN");
    expect(members).toHaveLength(1); // owner-1만

    // 만료
    const expired = { ...deps, now: () => new Date("2026-03-08T00:00:00.000Z") };
    expect(() => acceptInvitation(expired, acceptRequest())).toThrow(AppError);
    expect(members).toHaveLength(1);

    // 철회
    events.push({ id: "e1", tenantId: "tenant-a", invitationId: invitations[0]!.id, kind: "REVOKED", actorId: "owner-1", at: NOW.toISOString() });
    expect(codeOf({})).toBe("FORBIDDEN");
    expect(members).toHaveLength(1);
  });

  it("한 번 수락된 토큰은 다른 사용자가 다시 쓸 수 없고, 이미 같은 테넌트 멤버십이 있는 사용자는 수락할 수 없다 (BUSINESS_INVARIANT 422)", () => {
    const first = acceptScene();
    acceptInvitation(first.deps, first.acceptRequest());
    let code: string | undefined;
    try {
      acceptInvitation(first.deps, first.acceptRequest({ userId: "intruder-1" }));
    } catch (error) {
      code = (error as AppError).code;
    }
    expect(code).toBe("FORBIDDEN");
    expect(first.members.filter((m) => m.userId === "intruder-1")).toEqual([]);

    const second = acceptScene();
    try {
      acceptInvitation(second.deps, second.acceptRequest({ userId: "owner-1" })); // 이미 멤버
    } catch (error) {
      code = (error as AppError).code;
    }
    expect(code).toBe("BUSINESS_INVARIANT");
  });
});
