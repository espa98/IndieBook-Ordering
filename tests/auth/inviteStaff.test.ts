import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { invitationScene } from "../helpers/invitationFixtures";
import { inviteStaff, invitationStatus } from "../../src/auth/inviteStaff";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = new Date("2026-03-04T07:00:00.000Z");

describe("inviteStaff: 직원 초대 (ST-A03/A04, AUTH-004)", () => {
  it("Owner가 초대하면 토큰은 한 번만 돌려주고 저장소에는 해시만 남기며, 이메일은 소문자로 정규화되고 상태는 INVITED이다", () => {
    const { deps, invitations, inviteRequest } = invitationScene();

    const { invitation, token } = inviteStaff(deps, inviteRequest());

    expect(token).toBe("plain-token-1");
    expect(invitation).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      email: "staff@example.com",
      role: "STAFF",
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      invitedBy: "owner-1",
      invitedAt: "2026-03-04T07:00:00.000Z",
      expiresAt: "2026-03-07T07:00:00.000Z",
    });
    expect(invitation.tokenHash).not.toContain(token);
    expect(JSON.stringify(invitations)).not.toContain("plain-token-1");
    expect(invitationStatus(invitation, [], NOW)).toBe("INVITED");
  });

  const codeOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return (error as AppError).code;
    }
  };

  it("Staff는 초대할 수 없고(FORBIDDEN 403), 이메일·만료 시각·초대자 형식 오류는 VALIDATION_ERROR 400이며 아무것도 저장되지 않는다", () => {
    const { deps, invitations, inviteRequest } = invitationScene();

    expect(codeOf(() => inviteStaff(deps, inviteRequest({ actorRole: "STAFF" })))).toBe("FORBIDDEN");
    for (const bad of [
      { email: "" },
      { email: "not-an-email" },
      { invitedBy: " " },
      { expiresAt: "not-a-date" },
      { expiresAt: "2026-03-04T07:00:00.000Z" }, // 지금 = 이미 만료
      { expiresAt: "2026-03-01T00:00:00.000Z" },
      { expiresAt: "2026-06-04T07:00:00.000Z" }, // 30일 초과
    ]) {
      expect(codeOf(() => inviteStaff(deps, inviteRequest(bad)))).toBe("VALIDATION_ERROR");
    }
    expect(invitations).toEqual([]);
  });

  it("같은 이메일에 유효한 초대가 있으면 다시 초대할 수 없고, 만료·철회된 뒤에는 새 초대가 가능하다 (중복 초대 차단)", () => {
    const { deps, events, inviteRequest } = invitationScene();
    const first = inviteStaff(deps, inviteRequest()).invitation;

    expect(codeOf(() => inviteStaff(deps, inviteRequest({ email: "STAFF@example.com" })))).toBe("BUSINESS_INVARIANT");
    expect(inviteStaff(deps, inviteRequest({ email: "other@example.com" })).invitation.email).toBe("other@example.com");

    events.push({ id: "e1", tenantId: "tenant-a", invitationId: first.id, kind: "REVOKED", actorId: "owner-1", at: NOW.toISOString() });
    expect(codeOf(() => inviteStaff(deps, inviteRequest()))).toBeUndefined();
  });
});
