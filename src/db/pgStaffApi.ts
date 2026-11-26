import type { PoolClient } from "pg";
import { acceptInvitation } from "../auth/acceptInvitation";
import type { DelegationChange, DelegationKind, SetDelegationRequest } from "../auth/setDelegation";
import { authorizedActions } from "../auth/authorizedActions";
import type { Membership } from "../auth/authorizeTenantAccess";
import { hashInvitationToken, type InvitationEvent, type InviteStaffRequest, type StaffInvitation } from "../auth/inviteStaff";
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
/** 클라이언트에 나가는 초대: 서버 내부 값인 토큰 해시는 뺀다(토큰 원문은 처음 응답에만 있다) */
export type InviteStaffResult = { invitation: Omit<StaffInvitation, "tokenHash">; token: string };
/** 위임 부여·회수 요청 본문. 행위자(역할·이름)는 인증된 사용자에서 주입된다 */
export type SetDelegationBody = Omit<SetDelegationRequest, "actorRole" | "changedBy">;
/** 현재 위임의 한 줄(S-03) */
export type DelegationView = { userId: string; kind: DelegationKind; delegatedBy: string; delegatedAt: string };
/** 직원 목록의 한 줄(S-02). 이름·이메일은 인증 제공자에만 있어 사용자 ID로 식별한다 */
export type MemberView = { userId: string; role: "OWNER" | "STAFF"; status: "ACTIVE" | "INACTIVE"; joinedAt: string };
/** 초대 목록의 한 줄. 토큰 원문·해시는 없다 */
export type InvitationView = {
  id: string;
  email: string;
  role: "STAFF";
  invitedBy: string;
  invitedAt: string;
  expiresAt: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  resolvedAt?: string;
  resolvedBy?: string;
};
export type RevokeInvitationBody = Omit<RevokeInvitationRequest, "actorRole" | "revokedBy">;
export type SetMembershipStatusBody = Omit<SetMembershipStatusRequest, "actorRole" | "changedBy">;

/** 직원 초대·철회와 직원 비활성화·복구를 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 초대 토큰은 해시만 저장하고, 멱등 기록에도 원문을 남기지 않는다(같은 키의 재시도는 같은 초대를 돌려주되 토큰은 다시 주지 않는다).
 * 멤버십 변경은 서점의 멤버 행을 `FOR UPDATE`로 잡아 직렬화하고, 마지막 활성 Owner 보호는 DB 트리거도 한 번 더 막는다. */
export function createPgStaffApi(deps: { pool: PoolLike; now?: () => Date }) {
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

  const DELEGATION_TABLE: Record<DelegationKind, string> = {
    MANAGEMENT: "public.ordering_management_delegations",
    STOCK_ADJUSTMENT: "public.ordering_stock_delegations",
  };

  /** Owner가 직원에게 위임을 주고 거둔다. 서점의 멤버 행을 잠가 같은 서점의 동시 변경을 직렬화한다(같은 위임의 동시 부여는 하나만 성공) */
  const delegationOnce = (actor: Actor, request: SetDelegationBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      const members: Membership[] = isUuid(request.tenantId)
        ? (await client.query("select user_id, tenant_id, role, active from public.ordering_members where tenant_id = $1 order by user_id for update", [request.tenantId])).rows.map(
            (m): Membership => ({ userId: m.user_id, tenantId: m.tenant_id, role: m.role, status: m.active ? "ACTIVE" : "INACTIVE" }),
          )
        : [];
      const granted = new Set<string>();
      if (isUuid(request.tenantId)) {
        for (const kind of Object.keys(DELEGATION_TABLE) as DelegationKind[]) {
          for (const r of (await client.query(`select user_id from ${DELEGATION_TABLE[kind]} where tenant_id = $1`, [request.tenantId])).rows) granted.add(`${r.user_id}/${kind}`);
        }
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: DelegationChange[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.setDelegation(
        {
          memberships: { find: (userId, tenantId) => members.find((m) => m.userId === userId && m.tenantId === tenantId) },
          delegations: { isDelegated: (_tenant, userId, kind) => granted.has(`${userId}/${kind}`), save: (c) => void saved.push(c) },
          idempotency,
        },
        principal,
        rest,
      );
      for (const c of saved) {
        if (c.delegated) {
          await client.query(`insert into ${DELEGATION_TABLE[c.kind]} (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, $4)`, [c.tenantId, c.userId, c.changedBy, c.changedAt]);
        } else {
          await client.query(`delete from ${DELEGATION_TABLE[c.kind]} where tenant_id = $1 and user_id = $2`, [c.tenantId, c.userId]);
        }
        await client.query("insert into public.ordering_delegation_changes (id, tenant_id, user_id, kind, delegated, changed_by, changed_at) values ($1, $2, $3, $4, $5, $6, $7)", [c.id, c.tenantId, c.userId, c.kind, c.delegated, c.changedBy, c.changedAt]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  /** 계정(사용자 ID와 인증 제공자가 확인한 이메일)이 초대를 수락한다. 수락 시점에는 서점을 모르므로 토큰 해시로 초대를 찾는다.
   * 멱등 기록 대신 사건 기록으로 재시도를 알아본다: 같은 사용자가 이미 수락한 초대는 같은 멤버십을 돌려준다. */
  const acceptOnce = (actor: Actor & { email: string }, request: { token: string; idempotencyKey: string }) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const tokenHash = hashInvitationToken(String(request.token));
      const row = (await client.query("select * from public.ordering_staff_invitations where token_hash = $1", [tokenHash])).rows[0];
      if (row) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`inv:${row.tenant_id}:${row.email}`]);
      const invitations = row ? [toInvitation(row)] : [];
      const events = row ? (await client.query("select * from public.ordering_invitation_events where tenant_id = $1 and invitation_id = $2", [row.tenant_id, row.id])).rows.map(toEvent) : [];
      const memberships: Membership[] = row ? await loadMembership(client, actor.userId, row.tenant_id) : [];
      const replay = events.find((e) => e.kind === "ACCEPTED" && e.actorId === actor.userId);
      if (replay && memberships[0] && typeof actor.email === "string" && actor.email.trim().toLowerCase() === row.email) return memberships[0];
      const savedMemberships: Membership[] = [];
      const savedEvents: InvitationEvent[] = [];
      const membership = acceptInvitation(
        {
          invitations: { findByTokenHash: (hash) => invitations.find((i) => i.tokenHash === hash) },
          invitationEvents: { list: () => events, save: (e) => void savedEvents.push(e) },
          memberships: { find: (u, t) => memberships.find((m) => m.userId === u && m.tenantId === t), save: (m) => void savedMemberships.push(m) },
          idempotency: new Map(),
        },
        { token: request.token, userId: actor.userId, verifiedEmail: actor.email, idempotencyKey: request.idempotencyKey },
      );
      for (const m of savedMemberships) await client.query("insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, $3, $4)", [m.tenantId, m.userId, m.role, m.status === "ACTIVE"]);
      for (const e of savedEvents) await client.query("insert into public.ordering_invitation_events (id, tenant_id, invitation_id, kind, actor_id, at) values ($1, $2, $3, $4, $5, $6)", [e.id, e.tenantId, e.invitationId, e.kind, e.actorId, e.at]);
      return membership;
    });

  /** 직원 관리(S-02)는 Owner만 본다. 활성 Owner가 아니면 FORBIDDEN */
  const asOwner = <T>(actor: Actor, tenantId: string, run: (client: PoolClient) => Promise<T>): Promise<T> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, tenantId), actor.userId, tenantId);
      if (principal.role !== "OWNER") throw new AppError("FORBIDDEN");
      return run(client);
    });

  return {
    /** 서점의 모든 구성원(비활성 포함). Owner 먼저, 합류 순 */
    listMembers: (actor: Actor, request: { tenantId: string }): Promise<MemberView[]> =>
      asOwner(actor, request.tenantId, async (client) => {
        const rows = (
          await client.query("select user_id, role, active, created_at from public.ordering_members where tenant_id = $1 order by (role = 'OWNER') desc, created_at, user_id", [request.tenantId])
        ).rows;
        return rows.map((r): MemberView => ({ userId: r.user_id, role: r.role, status: r.active ? "ACTIVE" : "INACTIVE", joinedAt: iso(r.created_at) }));
      }),

    /** 현재 위임(직원별·종류별)을 직원·종류 순으로. Owner만 본다 */
    listDelegations: (actor: Actor, request: { tenantId: string }): Promise<DelegationView[]> =>
      asOwner(actor, request.tenantId, async (client) => {
        const out: DelegationView[] = [];
        for (const kind of Object.keys(DELEGATION_TABLE) as DelegationKind[]) {
          for (const r of (await client.query(`select user_id, delegated_by, delegated_at from ${DELEGATION_TABLE[kind]} where tenant_id = $1`, [request.tenantId])).rows) {
            out.push({ userId: r.user_id, kind, delegatedBy: r.delegated_by, delegatedAt: iso(r.delegated_at) });
          }
        }
        return out.sort((a, b) => (a.userId === b.userId ? (a.kind < b.kind ? -1 : 1) : a.userId < b.userId ? -1 : 1));
      }),

    /** 직원에게 위임을 주거나 거둔다(Owner만). 요청의 담당자 필드는 무시되고 인증된 사용자로 기록된다 */
    setDelegation: (actor: Actor, request: SetDelegationBody) => withRetry(() => delegationOnce(actor, request)),

    /** 서점의 초대(최신 초대 순)와 상태. 토큰 원문·해시는 포함하지 않는다 */
    listInvitations: (actor: Actor, request: { tenantId: string }): Promise<InvitationView[]> =>
      asOwner(actor, request.tenantId, async (client) => {
        const { invitations, events } = await loadInvitations(client, request.tenantId);
        const now = (deps.now ?? (() => new Date()))().getTime();
        return invitations
          .map((i): InvitationView => {
            const event = events.find((e) => e.invitationId === i.id);
            const status: InvitationView["status"] = event ? event.kind : Date.parse(i.expiresAt) <= now ? "EXPIRED" : "PENDING";
            return {
              id: i.id, email: i.email, role: i.role, invitedBy: i.invitedBy, invitedAt: i.invitedAt, expiresAt: i.expiresAt, status,
              ...(event ? { resolvedAt: event.at, resolvedBy: event.actorId } : {}),
            };
          })
          .sort((a, b) => (a.invitedAt === b.invitedAt ? (a.id < b.id ? 1 : -1) : a.invitedAt < b.invitedAt ? 1 : -1));
      }),

    acceptInvitation: (actor: Actor & { email: string }, request: { token: string; idempotencyKey: string }) => withRetry(() => acceptOnce(actor, request)),
    inviteStaff: async (actor: Actor, request: InviteStaffBody): Promise<InviteStaffResult> => {
      const { invitation, token } = await withRetry(() => inviteOnce(actor, request));
      const { tokenHash: _tokenHash, ...publicInvitation } = invitation;
      void _tokenHash;
      return { invitation: publicInvitation, token };
    },
    revokeInvitation: (actor: Actor, request: RevokeInvitationBody) => withRetry(() => revokeOnce(actor, request)),
    setMembershipStatus: (actor: Actor, request: SetMembershipStatusBody) => withRetry(() => statusOnce(actor, request)),
  };
}
