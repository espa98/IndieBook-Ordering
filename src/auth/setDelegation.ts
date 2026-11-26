import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString } from "../procurement/validation";
import type { Membership } from "./authorizeTenantAccess";

/** 위임 종류: 공급처·문구 템플릿 관리, 재고 조정 (STBR "O/위임 S") */
export type DelegationKind = "MANAGEMENT" | "STOCK_ADJUSTMENT";

/** 위임 변경 기록(추가 전용). 현재 위임 상태는 이 기록의 마지막 값이다 */
export type DelegationChange = {
  id: string;
  tenantId: string;
  userId: string;
  kind: DelegationKind;
  delegated: boolean;
  changedBy: string;
  changedAt: string;
};

export type SetDelegationDeps = {
  memberships: { find(userId: string, tenantId: string): Membership | undefined };
  delegations: {
    isDelegated(tenantId: string, userId: string, kind: DelegationKind): boolean;
    save(change: DelegationChange): void;
  };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type SetDelegationRequest = {
  tenantId: string;
  targetUserId: string;
  kind: DelegationKind;
  delegated: boolean;
  actorRole: "OWNER" | "STAFF";
  changedBy: string;
  idempotencyKey: string;
};

/** Owner가 직원에게 위임을 부여하거나 거둔다. */
export function setDelegation(deps: SetDelegationDeps, request: SetDelegationRequest): DelegationChange {
  if (request.actorRole !== "OWNER") throw new AppError("FORBIDDEN");
  if (request.kind !== "MANAGEMENT" && request.kind !== "STOCK_ADJUSTMENT") invalid("kind", "must be MANAGEMENT or STOCK_ADJUSTMENT");
  if (typeof request.delegated !== "boolean") invalid("delegated", "must be a boolean");
  if (!isNonEmptyString(request.changedBy)) invalid("changedBy", "must be a non-empty string");
  const now = (deps.now ?? (() => new Date()))();
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "auth.set-delegation",
      key: request.idempotencyKey,
      payload: { targetUserId: request.targetUserId, kind: request.kind, delegated: request.delegated },
    },
    () => {
      const target = deps.memberships.find(request.targetUserId, request.tenantId);
      if (!target) throw new AppError("NOT_FOUND");
      // 점주는 모든 권한이 있어 위임이 필요 없고, 비활성 직원에게는 새로 줄 수 없다(남은 위임은 거둘 수 있다)
      if (request.delegated && target.role !== "STAFF") throw new AppError("BUSINESS_INVARIANT", "only a staff member can be delegated");
      if (request.delegated && target.status !== "ACTIVE") throw new AppError("BUSINESS_INVARIANT", "an inactive member cannot be delegated");
      if (deps.delegations.isDelegated(request.tenantId, target.userId, request.kind) === request.delegated) {
        throw new AppError("BUSINESS_INVARIANT", request.delegated ? "the delegation is already granted" : "the delegation is not granted");
      }
      const change: DelegationChange = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        userId: request.targetUserId,
        kind: request.kind,
        delegated: request.delegated,
        changedBy: request.changedBy,
        changedAt: now.toISOString(),
      };
      deps.delegations.save(change);
      return change;
    },
  );
}
