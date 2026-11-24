import { describe, it, expect } from "vitest";
import { acceptInvitationAsAccount } from "../../src/auth/acceptInvitation";
import type { Membership } from "../../src/auth/authorizeTenantAccess";
import { resolveAccountPrincipal } from "../../src/auth/accountPrincipal";
import { registerAccount, verifyEmail } from "../../src/auth/accounts";
import { inviteStaff } from "../../src/auth/inviteStaff";
import { AppError } from "../../src/errors/AppError";
import { accountScene } from "../helpers/accountFixtures";
import { invitationScene } from "../helpers/invitationFixtures";

function scene() {
  const inv = invitationScene();
  const acc = accountScene();
  const members: Membership[] = [];
  const memberships = {
    find: (u: string, t: string) => members.find((m) => m.userId === u && m.tenantId === t),
    save: (m: Membership) => void members.push(m),
  };
  const { token } = inviteStaff(inv.deps, inv.inviteRequest({ email: "staff@example.com" }));
  const deps = { ...inv.deps, accounts: acc.deps.accounts, memberships };
  const signUp = (userId: string, email: string, verify: boolean) => {
    const r = registerAccount(acc.deps, { userId, email, idempotencyKey: `reg-${userId}` });
    if (verify) verifyEmail(acc.deps, { token: r.token, idempotencyKey: `ver-${userId}` });
    return resolveAccountPrincipal({ accounts: acc.deps.accounts, now: acc.deps.now }, { userId, sessionExpiresAt: "2026-03-04T08:00:00.000Z" });
  };
  return { deps, members, token, signUp };
}

describe("acceptInvitationAsAccount: 확인된 계정으로만 초대를 수락 (ST-A03)", () => {
  it("이메일을 인증한 계정이 자기 이메일로 온 초대를 수락하면 그 계정으로 Staff 멤버십이 만들어진다 (요청에 사용자·이메일을 주장할 수 없다)", () => {
    const { deps, members, token, signUp } = scene();

    const membership = acceptInvitationAsAccount(deps, signUp("staff-9", "Staff@Example.com", true), { token, idempotencyKey: "acc-1" });

    expect(membership).toEqual({ userId: "staff-9", tenantId: "tenant-a", role: "STAFF", status: "ACTIVE" });
    expect(members).toEqual([membership]);
  });

  it("이메일을 인증하지 않은 계정과 이메일이 다른 계정은 FORBIDDEN 403이고 멤버십이 생기지 않는다", () => {
    const { deps, members, token, signUp } = scene();
    const unverified = signUp("staff-8", "staff@example.com", false);
    const other = signUp("other-1", "other@example.com", true);
    const codeOf = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(codeOf(() => acceptInvitationAsAccount(deps, unverified, { token, idempotencyKey: "a-1" }))).toBe("FORBIDDEN");
    expect(codeOf(() => acceptInvitationAsAccount(deps, other, { token, idempotencyKey: "a-2" }))).toBe("FORBIDDEN");
    expect(members).toEqual([]);
  });
});
