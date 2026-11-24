import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString } from "../procurement/validation";
import {
  invitationStatus,
  type InvitationEvent,
  type InvitationEventRepository,
  type InvitationRepository,
} from "./inviteStaff";

export type RevokeInvitationDeps = {
  invitations: Pick<InvitationRepository, "get">;
  invitationEvents: InvitationEventRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RevokeInvitationRequest = {
  tenantId: string;
  invitationId: string;
  actorRole: "OWNER" | "STAFF";
  revokedBy: string;
  idempotencyKey: string;
};

/** 아직 수락되지 않은 초대를 철회한다 (ST-A04). 철회된 토큰은 다시 쓸 수 없다. */
export function revokeInvitation(
  deps: RevokeInvitationDeps,
  request: RevokeInvitationRequest,
): InvitationEvent {
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (!isNonEmptyString(request.revokedBy)) {
    invalid("revokedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "auth.revoke-invitation",
      key: request.idempotencyKey,
      payload: { invitationId: request.invitationId, revokedBy: request.revokedBy },
    },
    () => {
      const invitation = deps.invitations.get(request.tenantId, request.invitationId);
      if (!invitation) {
        throw new AppError("NOT_FOUND");
      }
      const events = deps.invitationEvents.list(request.tenantId, invitation.id);
      if (invitationStatus(invitation, events, now) !== "INVITED") {
        throw new AppError("BUSINESS_INVARIANT", "only a pending invitation can be revoked");
      }
      const event: InvitationEvent = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        invitationId: invitation.id,
        kind: "REVOKED",
        actorId: request.revokedBy,
        at: now.toISOString(),
      };
      deps.invitationEvents.save(event);
      return event;
    },
  );
}
