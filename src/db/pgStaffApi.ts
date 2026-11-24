import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { Membership } from "../auth/authorizeTenantAccess";
import type { InvitationEvent, InviteStaffRequest, StaffInvitation } from "../auth/inviteStaff";
import type { RevokeInvitationRequest } from "../auth/revokeInvitation";
import type { MembershipChange, SetMembershipStatusRequest } from "../auth/setMembershipStatus";
import { AppError } from "../errors/AppError";
import {
  inTransaction,
  isCommandKeyConflict,
  isUuid,
  loadCommands,
  loadMembership,
  principalFor,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";

type Actor = { userId: string };
const iso = (value: Date) => value.toISOString();

/** 호출자가 보내는 요청. 행위자(역할·이름)는 인증된 사용자에서 주입되므로 보낼 필요가 없다 */
export type InviteStaffBody = Omit<InviteStaffRequest, "actorRole" | "invitedBy">;
export type RevokeInvitationBody = Omit<RevokeInvitationRequest, "actorRole" | "revokedBy">;
export type SetMembershipStatusBody = Omit<SetMembershipStatusRequest, "actorRole" | "changedBy">;

/** 직원 초대·철회와 직원 비활성화·복구를 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 초대 토큰은 해시만 저장하고, 멱등 기록에도 원문을 남기지 않는다(같은 키의 재시도는 같은 초대를 돌려주되 토큰은 다시 주지 않는다).
 * 멤버십 변경은 서점의 멤버 행을 `FOR UPDATE`로 잡아 직렬화하고, 마지막 활성 Owner 보호는 DB 트리거도 한 번 더 막는다. */
export function createPgStaffApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        if ((error as { code?: string }).code === "P0001") throw new AppError("BUSINESS_INVARIANT", (error as Error).message);
        throw error;
      }
    }
  };

  const toInvitation = (i: any): StaffInvitation => ({
    id: i.id,
    tenantId: i.tenant_id,
    email: i.email,
    role: "STAFF",
    tokenHash: i.token_hash,
    invitedBy: i.invited_by,
    invitedAt: iso(i.invited_at),
    expiresAt: iso(i.expires_at),
  });
  const toEvent = (e: any): InvitationEvent => ({ id: e.id, tenantId: e.tenant_id, invitationId: e.invitation_id, kind: e.kind, actorId: e.actor_id, at: iso(e.at) });

  async function loadInvitations(client: PoolClient, tenantId: string) {
    const invitations = (await client.query("select * from public.ordering_staff_invitations where tenant_id = $1 order by recorded_at, id", [tenantId])).rows.map(toInvitation);
    const events = (await client.query("select * from public.ordering_invitation_events where tenant_id = $1 order by recorded_at, id", [tenantId])).rows.map(toEvent);
    return { invitations, events };
  }

  const inviteOnce = (actor: Actor, request: InviteStaffBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const email = typeof request.email === "string" ? request.email.trim().toLowerCase() : "";
      // 같은 이메일의 초대를 직렬화한다(DB 트리거도 같은 키를 잡는다)
      if (isUuid(request.tenantId) && email) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`inv:${request.tenantId}:${email}`]);
      const state = isUuid(request.tenantId) ? await loadInvitations(client, request.tenantId) : { invitations: [] as StaffInvitation[], events: [] as InvitationEvent[] };
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: StaffInvitation[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.inviteStaff(
        {
          invitations: {
            get: (_t2, id) => state.invitations.find((i) => i.id === id),
            list: () => state.invitations,
            findByTokenHash: (hash) => state.invitations.find((i) => i.tokenHash === hash),
            save: (i) => void saved.push(i),
          },
          invitationEvents: { list: (_t2, id) => state.events.filter((e) => e.invitationId === id) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const i of saved) {
        await client.query("insert into public.ordering_staff_invitations (id, tenant_id, email, role, token_hash, invited_by, invited_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [i.id, i.tenantId, i.email, i.role, i.tokenHash, i.invitedBy, i.invitedAt, i.expiresAt]);
      }
      // 멱등 기록에는 토큰 원문을 남기지 않는다: 재시도는 같은 초대를 돌려주되 토큰은 다시 주지 않는다
      for (const [storeKey, entry] of idempotency) {
        if (known.has(storeKey)) continue;
        const stored = entry.result as { invitation: StaffInvitation; token?: string | null };
        entry.result = { invitation: stored.invitation, token: null };
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const revokeOnce = (actor: Actor, request: RevokeInvitationBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const target = isUuid(request.tenantId) && isUuid(request.invitationId)
        ? (await client.query("select email from public.ordering_staff_invitations where tenant_id = $1 and id = $2", [request.tenantId, request.invitationId])).rows[0]
        : undefined;
      if (target) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`inv:${request.tenantId}:${target.email}`]);
      const state = isUuid(request.tenantId) ? await loadInvitations(client, request.tenantId) : { invitations: [] as StaffInvitation[], events: [] as InvitationEvent[] };
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: InvitationEvent[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.revokeInvitation(
        {
          invitations: { get: (_t2, id) => state.invitations.find((i) => i.id === id) },
          invitationEvents: { list: (_t2, id) => state.events.filter((e) => e.invitationId === id), save: (e) => void saved.push(e) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const e of saved) {
        await client.query("insert into public.ordering_invitation_events (id, tenant_id, invitation_id, kind, actor_id, at) values ($1, $2, $3, $4, $5, $6)", [e.id, e.tenantId, e.invitationId, e.kind, e.actorId, e.at]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const statusOnce = (actor: Actor, request: SetMembershipStatusBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      // 서점의 멤버 행을 잠가 같은 서점의 동시 변경(두 Owner를 서로 내리는 경쟁 등)을 직렬화한다
      const members: Membership[] = isUuid(request.tenantId)
        ? (await client.query("select user_id, tenant_id, role, active from public.ordering_members where tenant_id = $1 order by user_id for update", [request.tenantId])).rows.map(
            (m): Membership => ({ userId: m.user_id, tenantId: m.tenant_id, role: m.role, status: m.active ? "ACTIVE" : "INACTIVE" }),
          )
        : [];
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const savedMemberships: Membership[] = [];
      const savedChanges: MembershipChange[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.setMembershipStatus(
        {
          memberships: {
            find: (userId, tenantId) => members.find((m) => m.userId === userId && m.tenantId === tenantId),
            listByTenant: () => members,
            save: (m) => void savedMemberships.push(m),
          },
          membershipChanges: { save: (c) => void savedChanges.push(c) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const c of savedChanges) {
        await client.query("insert into public.ordering_membership_changes (id, tenant_id, user_id, from_status, to_status, changed_by, changed_at) values ($1, $2, $3, $4, $5, $6, $7)", [c.id, c.tenantId, c.userId, c.from, c.to, c.changedBy, c.changedAt]);
      }
      for (const m of savedMemberships) {
        await client.query("update public.ordering_members set active = $3 where tenant_id = $1 and user_id = $2", [m.tenantId, m.userId, m.status === "ACTIVE"]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  return {
    inviteStaff: (actor: Actor, request: InviteStaffBody) => withRetry(() => inviteOnce(actor, request)),
    revokeInvitation: (actor: Actor, request: RevokeInvitationBody) => withRetry(() => revokeOnce(actor, request)),
    setMembershipStatus: (actor: Actor, request: SetMembershipStatusBody) => withRetry(() => statusOnce(actor, request)),
  };
}
