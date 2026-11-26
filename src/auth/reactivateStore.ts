import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { validateStatusChangeFields, type StoreStatusChange, type StoreStatusStore } from "./deactivateStore";

export type ReactivateStoreDeps = { stores: StoreStatusStore; idempotency: IdempotencyStore; now?: () => Date };

/**
 * 플랫폼 운영자의 승인 요청. 서점 구성원(Owner·Staff)이 아니라 운영자 주체의 명령이라 서점 범위 요청(`tenantId`·`actorRole`)이 아니다.
 * 운영자인지 확인하는 일은 HTTP 경계(허용된 운영자 계정 목록)가 하고, 이 명령은 그 확인을 거친 호출만 받는다.
 */
export type ReactivateStoreRequest = {
  storeId: string;
  reason: string;
  adminUserId: string;
  approvedAt: string;
  idempotencyKey: string;
};

/** 운영자가 중지·해지된 서점의 재사용을 승인한다. 이미 사용 중인 서점에는 할 수 없다 */
export function reactivateStore(deps: ReactivateStoreDeps, request: ReactivateStoreRequest): StoreStatusChange {
  validateStatusChangeFields({ reason: request.reason, by: request.adminUserId, at: request.approvedAt }, "adminUserId", "approvedAt", (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    { tenantId: request.storeId, operation: "auth.reactivate-store", key: request.idempotencyKey, payload: { reason: request.reason, adminUserId: request.adminUserId, approvedAt: request.approvedAt } },
    () => {
      const from = deps.stores.getStatus(request.storeId);
      if (from === undefined) throw new AppError("NOT_FOUND");
      if (from === "ACTIVE") throw new AppError("BUSINESS_INVARIANT", "the store is already active");
      const change: StoreStatusChange = { id: crypto.randomUUID(), tenantId: request.storeId, kind: "REACTIVATED", from, to: "ACTIVE", reason: request.reason.trim(), by: request.adminUserId, at: request.approvedAt };
      deps.stores.apply(change, "ACTIVE");
      return change;
    },
  );
}
