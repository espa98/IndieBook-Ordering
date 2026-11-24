import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../errors/AppError";
import { invalid, isNonEmptyString } from "../procurement/validation";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";

/** 직원 초대 (추가 전용). 토큰은 해시만 저장한다. 상태는 사건 기록과 만료 시각에서 파생한다 (ST-A03/A04). */
export type StaffInvitation = {
  id: string;
  tenantId: string;
  email: string;
  role: "STAFF";
  tokenHash: string;
  invitedBy: string;
  invitedAt: string;
  expiresAt: string;
};

export type InvitationEvent = {
  id: string;
  tenantId: string;
  invitationId: string;
  kind: "ACCEPTED" | "REVOKED";
  actorId: string;
  at: string;
};

export type InvitationStatus = "INVITED" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export type InvitationRepository = {
  get(tenantId: string, id: string): StaffInvitation | undefined;
  list(tenantId: string): StaffInvitation[];
  findByTokenHash(tokenHash: string): StaffInvitation | undefined;
  save(invitation: StaffInvitation): void;
};

export type InvitationEventRepository = {
  list(tenantId: string, invitationId: string): InvitationEvent[];
  save(event: InvitationEvent): void;
};

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 처리된 초대는 그 결과가, 아니면 만료 시각이 지났는지가 상태다. 만료·철회·수락된 초대는 다시 쓸 수 없다. */
export function invitationStatus(
  invitation: StaffInvitation,
  events: readonly InvitationEvent[],
  now: Date,
): InvitationStatus {
  const last = events[events.length - 1];
  if (last) return last.kind;
  return Date.parse(invitation.expiresAt) <= now.getTime() ? "EXPIRED" : "INVITED";
}

const MAX_INVITATION_DAYS = 30;

export type InviteStaffDeps = {
  invitations: InvitationRepository;
  invitationEvents: Pick<InvitationEventRepository, "list">;
  generateToken?: () => string;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type InviteStaffRequest = {
  tenantId: string;
  email: string;
  actorRole: "OWNER" | "STAFF";
  invitedBy: string;
  expiresAt: string;
  idempotencyKey: string;
};

export function inviteStaff(
  deps: InviteStaffDeps,
  request: InviteStaffRequest,
): { invitation: StaffInvitation; token: string } {
  // 직원 초대는 Owner 업무다
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  const email = typeof request.email === "string" ? request.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    invalid("email", "must be a valid email address");
  }
  if (!isNonEmptyString(request.invitedBy)) {
    invalid("invitedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  const expiresMs = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(request.expiresAt)
    ? Date.parse(request.expiresAt)
    : Number.NaN;
  if (
    Number.isNaN(expiresMs) ||
    expiresMs <= now.getTime() ||
    expiresMs > now.getTime() + MAX_INVITATION_DAYS * 86_400_000
  ) {
    invalid("expiresAt", `must be a future time within ${MAX_INVITATION_DAYS} days`);
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "auth.invite-staff",
      key: request.idempotencyKey,
      payload: { email, invitedBy: request.invitedBy, expiresAt: request.expiresAt },
    },
    () => {
      // 같은 이메일에 아직 쓸 수 있는 초대가 있으면 중복 초대다
      const pending = deps.invitations
        .list(request.tenantId)
        .some(
          (i) =>
            i.email === email &&
            invitationStatus(i, deps.invitationEvents.list(request.tenantId, i.id), now) === "INVITED",
        );
      if (pending) {
        throw new AppError("BUSINESS_INVARIANT", "an active invitation already exists for this email");
      }
      const token = (deps.generateToken ?? (() => randomUUID() + randomUUID()))();
      const invitation: StaffInvitation = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        email,
        role: "STAFF",
        tokenHash: hashInvitationToken(token),
        invitedBy: request.invitedBy,
        invitedAt: now.toISOString(),
        expiresAt: request.expiresAt,
      };
      deps.invitations.save(invitation);
      return { invitation, token };
    },
  );
}
