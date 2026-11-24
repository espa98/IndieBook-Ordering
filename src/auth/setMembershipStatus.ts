import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString } from "../procurement/validation";
import type { Membership, MembershipRepository } from "./authorizeTenantAccess";

/** 멤버십 상태 변경 기록 (추가 전용, ST-A05). */
export type MembershipChange = {
  id: string;
  tenantId: string;
  userId: string;
  from: Membership["status"];
  to: Membership["status"];
  changedBy: string;
  changedAt: string;
};

export type SetMembershipStatusDeps = {
  memberships: MembershipRepository & {
    listByTenant(tenantId: string): Membership[];
    save(membership: Membership): void;
  };
  membershipChanges: { save(change: MembershipChange): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type SetMembershipStatusRequest = {
  tenantId: string;
  targetUserId: string;
  status: Membership["status"];
  actorRole: "OWNER" | "STAFF";
  changedBy: string;
  idempotencyKey: string;
};

/**
 * 직원을 비활성화하거나 복구한다 (ST-A05). 멤버십을 호출마다 다시 읽는 주체 도출 덕분에
 * 비활성화는 즉시 서버 접근을 막는다. 마지막 활성 Owner는 비활성화할 수 없다 (BR-T06).
 */
export function setMembershipStatus(
  deps: SetMembershipStatusDeps,
  request: SetMembershipStatusRequest,
): MembershipChange {
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (request.status !== "ACTIVE" && request.status !== "INACTIVE") {
    invalid("status", "must be ACTIVE or INACTIVE");
  }
  if (!isNonEmptyString(request.changedBy)) {
    invalid("changedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "auth.set-membership-status",
      key: request.idempotencyKey,
      payload: { targetUserId: request.targetUserId, status: request.status, changedBy: request.changedBy },
    },
    () => {
      const target = deps.memberships.find(request.targetUserId, request.tenantId);
      if (!target) {
        throw new AppError("NOT_FOUND");
      }
      if (target.status === request.status) {
        throw new AppError("BUSINESS_INVARIANT", "the membership already has this status");
      }
      if (request.status === "INACTIVE" && target.role === "OWNER") {
        const otherActiveOwners = deps.memberships
          .listByTenant(request.tenantId)
          .filter((m) => m.role === "OWNER" && m.status === "ACTIVE" && m.userId !== target.userId);
        if (otherActiveOwners.length === 0) {
          throw new AppError("BUSINESS_INVARIANT", "the last active owner cannot be deactivated");
        }
      }
      deps.memberships.save({ ...target, status: request.status });
      const change: MembershipChange = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        userId: target.userId,
        from: target.status,
        to: request.status,
        changedBy: request.changedBy,
        changedAt: now.toISOString(),
      };
      deps.membershipChanges.save(change);
      return change;
    },
  );
}
