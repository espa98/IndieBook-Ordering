import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { AccountPrincipal } from "./accountPrincipal";
import type { Membership, MembershipRepository } from "./authorizeTenantAccess";
import {
  hashInvitationToken,
  invitationStatus,
  type InvitationEventRepository,
  type InvitationRepository,
} from "./inviteStaff";

export type AcceptInvitationDeps = {
  invitations: Pick<InvitationRepository, "findByTokenHash">;
  invitationEvents: InvitationEventRepository;
  memberships: MembershipRepository & { save(membership: Membership): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type AcceptInvitationRequest = {
  token: string;
  /** 인증된 계정의 사용자 ID */
  userId: string;
  /** 인증 제공자가 확인한 계정 이메일. 초대 이메일과 같아야 한다 */
  verifiedEmail: string;
  idempotencyKey: string;
};

/**
 * 초대를 수락해 활성 Staff 멤버십을 만든다 (ST-A03). 토큰이 틀렸거나 만료·철회·재사용되었거나
 * 이메일이 다르면 이유를 구별할 수 없게 같은 FORBIDDEN으로 거부한다.
 */
export function acceptInvitation(
  deps: AcceptInvitationDeps,
  request: AcceptInvitationRequest,
): Membership {
  const now = (deps.now ?? (() => new Date()))();
  return executeIdempotent(
    deps.idempotency,
    {
      // 수락 시점에는 테넌트를 모른다. 토큰이 테넌트를 정한다
      tenantId: "-",
      operation: "auth.accept-invitation",
      key: request.idempotencyKey,
      payload: { tokenHash: hashInvitationToken(String(request.token)), userId: request.userId, verifiedEmail: request.verifiedEmail },
    },
    () => {
      const invitation = deps.invitations.findByTokenHash(hashInvitationToken(String(request.token)));
      if (
        !invitation ||
        invitationStatus(invitation, deps.invitationEvents.list(invitation.tenantId, invitation.id), now) !== "INVITED" ||
        typeof request.verifiedEmail !== "string" ||
        request.verifiedEmail.trim().toLowerCase() !== invitation.email
      ) {
        throw new AppError("FORBIDDEN");
      }
      if (deps.memberships.find(request.userId, invitation.tenantId)) {
        throw new AppError("BUSINESS_INVARIANT", "the user already has a membership in this tenant");
      }
      const membership: Membership = {
        userId: request.userId,
        tenantId: invitation.tenantId,
        role: invitation.role,
        status: "ACTIVE",
      };
      deps.memberships.save(membership);
      deps.invitationEvents.save({
        id: crypto.randomUUID(),
        tenantId: invitation.tenantId,
        invitationId: invitation.id,
        kind: "ACCEPTED",
        actorId: request.userId,
        at: now.toISOString(),
      });
      return membership;
    },
  );
}

/**
 * 확인된 계정 주체로 초대를 수락한다. 사용자 ID와 확인된 이메일을 요청이 아니라 계정에서 가져오므로
 * 호출자가 다른 사람의 이메일을 주장할 수 없다. 이메일을 인증하지 않은 계정은 거부한다 (ST-A01, ST-A03).
 */
export function acceptInvitationAsAccount(
  deps: AcceptInvitationDeps,
  principal: AccountPrincipal,
  request: { token: string; idempotencyKey: string },
): Membership {
  if (!principal.verified) {
    throw new AppError("FORBIDDEN");
  }
  return acceptInvitation(deps, {
    token: request.token,
    userId: principal.userId,
    verifiedEmail: principal.email,
    idempotencyKey: request.idempotencyKey,
  });
}
