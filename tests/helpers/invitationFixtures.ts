import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type {
  InviteStaffRequest,
  InvitationEvent,
  StaffInvitation,
} from "../../src/auth/inviteStaff";

const NOW = new Date("2026-03-04T07:00:00.000Z");

/** 인메모리 초대·사건 저장소와 고정 토큰·시각이 있는 세계 */
export function invitationScene() {
  const invitations: StaffInvitation[] = [];
  const events: InvitationEvent[] = [];
  const deps = {
    invitations: {
      get: (t: string, id: string) => invitations.find((i) => i.tenantId === t && i.id === id),
      list: (t: string) => invitations.filter((i) => i.tenantId === t),
      findByTokenHash: (hash: string) => invitations.find((i) => i.tokenHash === hash),
      save: (i: StaffInvitation) => void invitations.push(i),
    },
    invitationEvents: {
      list: (t: string, id: string) => events.filter((e) => e.tenantId === t && e.invitationId === id),
      save: (e: InvitationEvent) => void events.push(e),
    },
    generateToken: () => "plain-token-1",
    idempotency: createIdempotencyStore(),
    now: () => NOW,
  };
  let seq = 0;
  const inviteRequest = (extra: Partial<InviteStaffRequest> = {}): InviteStaffRequest => ({
    tenantId: "tenant-a",
    email: "Staff@Example.com",
    actorRole: "OWNER",
    invitedBy: "owner-1",
    expiresAt: "2026-03-07T07:00:00.000Z",
    idempotencyKey: `inv-${++seq}`,
    ...extra,
  });
  return { deps, invitations, events, inviteRequest };
}
