import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";

/** 서점 상태. ACTIVE가 아니면 서점은 사용할 수 없고 운영자 승인으로만 다시 ACTIVE가 된다 */
export type StoreStatus = "ACTIVE" | "SUSPENDED" | "TERMINATED";

/** 서점 상태 변경 이력(추가 전용) */
export type StoreStatusChange = {
  id: string;
  tenantId: string;
  kind: "DEACTIVATED" | "REACTIVATED";
  from: StoreStatus;
  to: StoreStatus;
  reason: string;
  by: string;
  at: string;
};

export type StoreStatusStore = {
  getStatus(tenantId: string): StoreStatus | undefined;
  /** 변경 이력을 남기고 서점 상태를 새 값으로 바꾼다 */
  apply(change: StoreStatusChange, next: StoreStatus): void;
};

export type DeactivateStoreDeps = { stores: StoreStatusStore; idempotency: IdempotencyStore; now?: () => Date };

export type DeactivateStoreRequest = {
  tenantId: string;
  kind: "SUSPENDED" | "TERMINATED";
  reason: string;
  actorRole: "OWNER" | "STAFF";
  changedBy: string;
  changedAt: string;
  idempotencyKey: string;
};

export const MAX_STORE_STATUS_REASON_LENGTH = 500;

/** 상태 변경 요청의 공통 검증: 사유(1~500자)·담당자·시각 */
export function validateStatusChangeFields(fields: { reason: unknown; by: unknown; at: unknown }, byField: string, atField: string, now: Date): void {
  if (!isNonEmptyString(fields.reason) || fields.reason.trim().length > MAX_STORE_STATUS_REASON_LENGTH) invalid("reason", `must be a non-empty string up to ${MAX_STORE_STATUS_REASON_LENGTH} characters`);
  if (!isNonEmptyString(fields.by)) invalid(byField, "must be a non-empty string");
  parseUtcTimestamp(atField, fields.at, now);
}

/**
 * Owner가 서점을 중지(SUSPENDED)하거나 해지(TERMINATED)한다. 그 순간부터 서점은 사용할 수 없고(서점 범위 요청 거부),
 * 운영자 승인(`reactivateStore`)으로만 다시 사용할 수 있다. 이미 중지·해지된 서점에는 할 수 없다.
 */
export function deactivateStore(deps: DeactivateStoreDeps, request: DeactivateStoreRequest): StoreStatusChange {
  if (request.actorRole !== "OWNER") throw new AppError("FORBIDDEN");
  if (request.kind !== "SUSPENDED" && request.kind !== "TERMINATED") invalid("kind", "must be SUSPENDED or TERMINATED");
  validateStatusChangeFields({ reason: request.reason, by: request.changedBy, at: request.changedAt }, "changedBy", "changedAt", (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    { tenantId: request.tenantId, operation: "auth.deactivate-store", key: request.idempotencyKey, payload: { kind: request.kind, reason: request.reason, changedBy: request.changedBy, changedAt: request.changedAt } },
    () => {
      const from = deps.stores.getStatus(request.tenantId);
      if (from === undefined) throw new AppError("NOT_FOUND");
      if (from !== "ACTIVE") throw new AppError("BUSINESS_INVARIANT", "the store is already suspended or terminated");
      const change: StoreStatusChange = { id: crypto.randomUUID(), tenantId: request.tenantId, kind: "DEACTIVATED", from, to: request.kind, reason: request.reason.trim(), by: request.changedBy, at: request.changedAt };
      deps.stores.apply(change, request.kind);
      return change;
    },
  );
}
