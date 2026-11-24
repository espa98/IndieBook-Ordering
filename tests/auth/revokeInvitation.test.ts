import { describe, it, expect } from "vitest";
import { acceptInvitation } from "../../src/auth/acceptInvitation";
import { invitationStatus, inviteStaff } from "../../src/auth/inviteStaff";
import { revokeInvitation } from "../../src/auth/revokeInvitation";
import type { RevokeInvitationRequest } from "../../src/auth/revokeInvitation";
import type { Membership } from "../../src/auth/authorizeTenantAccess";
import { AppError } from "../../src/errors/AppError";
import { invitationScene } from "../helpers/invitationFixtures";

const NOW = new Date("2026-03-04T07:00:00.000Z");

function revokeScene() {
  const s = invitationScene();
  const { invitation, token } = inviteStaff(s.deps, s.inviteRequest());
  const members: Membership[] = [];
  const memberships = {
    find: (userId: string, tenantId: string) => members.find((m) => m.userId === userId && m.tenantId === tenantId),
    save: (m: Membership) => void members.push(m),
  };
  const deps = { ...s.deps, memberships };
  let seq = 0;
  const revokeRequest = (extra: Partial<RevokeInvitationRequest> = {}): RevokeInvitationRequest => ({
    tenantId: "tenant-a",
    invitationId: invitation.id,
    actorRole: "OWNER",
    revokedBy: "owner-1",
    idempotencyKey: `rev-${++seq}`,
    ...extra,
  });
  return { ...s, deps, invitation, token, members, revokeRequest };
}

describe("revokeInvitation: 초대 철회 (ST-A04)", () => {
  it("Owner가 아직 수락되지 않은 초대를 철회하면 REVOKED가 되고 그 토큰으로는 수락할 수 없다", () => {
    const { deps, invitation, token, events, members, revokeRequest } = revokeScene();

    revokeInvitation(deps, revokeRequest());

    expect(events).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", invitationId: invitation.id, kind: "REVOKED", actorId: "owner-1" }),
    ]);
    expect(invitationStatus(invitation, events, NOW)).toBe("REVOKED");
    expect(() =>
      acceptInvitation(deps, { token, userId: "staff-9", verifiedEmail: "staff@example.com", idempotencyKey: "acc-r" }),
    ).toThrow(AppError);
    expect(members).toEqual([]);
  });

  it("Staff는 철회할 수 없고(FORBIDDEN), 없는 초대·다른 테넌트의 초대는 NOT_FOUND, 이미 수락·철회·만료된 초대는 BUSINESS_INVARIANT 422이다", () => {
    const { deps, events, revokeRequest, token } = revokeScene();
    const codeOf = (extra: Partial<RevokeInvitationRequest>, target = deps) => {
      try {
        revokeInvitation(target, revokeRequest(extra));
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf({ actorRole: "STAFF" })).toBe("FORBIDDEN");
    expect(codeOf({ invitationId: "no-such" })).toBe("NOT_FOUND");
    expect(codeOf({ tenantId: "tenant-b" })).toBe("NOT_FOUND");
    expect(codeOf({ revokedBy: " " })).toBe("VALIDATION_ERROR");
    expect(events).toEqual([]);

    expect(codeOf({})).toBeUndefined();
    expect(codeOf({})).toBe("BUSINESS_INVARIANT"); // 이미 철회됨
    expect(codeOf({}, { ...deps, now: () => new Date("2026-03-08T00:00:00.000Z") })).toBe("BUSINESS_INVARIANT");
    expect(token).toBeDefined();
    expect(events).toHaveLength(1);
  });
});
