import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { anonymizeCustomer } from "./anonymizeCustomer";
import type { Customer, CustomerChange } from "./registerCustomer";

/** 한 번에 익명화하는 최대 고객 수. 남은 고객은 `hasMore`로 알리고 다시 실행하면 이어서 처리한다 */
export const RETENTION_BATCH_SIZE = 100;

export type ApplyCustomerRetentionDeps = {
  customers: { list(tenantId: string): Customer[]; get(tenantId: string, id: string): Customer | undefined; save(customer: Customer): void };
  customerChanges: { save(change: CustomerChange): void };
  stores: { getRetentionDays(tenantId: string): number | undefined };
  /** 고객의 마지막 활동(등록·수정·주문 연결 중 가장 늦은 시각) */
  activity: {
    lastActivityAt(tenantId: string, customerId: string): string | undefined;
    /** 고객이 현재 연결된 주문이 아직 열려 있는가(종결·취소·폐기 전). 열려 있으면 안내 연락처가 필요해 익명화하지 않는다 */
    hasOpenOrder(tenantId: string, customerId: string): boolean;
  };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ApplyCustomerRetentionRequest = {
  tenantId: string;
  actorRole: "OWNER" | "STAFF";
  appliedBy: string;
  appliedAt: string;
  idempotencyKey: string;
};

export type ApplyCustomerRetentionResult = { retentionDays: number; cutoff: string; anonymizedCustomerIds: string[]; hasMore: boolean };

/**
 * Owner가 정한 보존기간(일)이 지난 고객을 익명화한다(고객 결정 #2). 마지막 활동이 `appliedAt - 보존기간`보다 이전인 고객만 대상이고
 * 정확히 기한인 고객은 아직 아니다. 아직 열려 있는 주문에 연결된 고객은 제외한다(안내 연락처가 필요하다). 보존기간이 없으면(기한 없음) 거부한다. 익명화는 `anonymizeCustomer`와 같은 규칙·이력을 쓴다.
 */
export function applyCustomerRetention(deps: ApplyCustomerRetentionDeps, request: ApplyCustomerRetentionRequest): ApplyCustomerRetentionResult {
  if (!isNonEmptyString(request.appliedBy)) invalid("appliedBy", "must be a non-empty string");
  const appliedMs = parseUtcTimestamp("appliedAt", request.appliedAt, (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    { tenantId: request.tenantId, operation: "customer.apply-retention", key: request.idempotencyKey, payload: { appliedBy: request.appliedBy, appliedAt: request.appliedAt } },
    () => {
      const retentionDays = deps.stores.getRetentionDays(request.tenantId);
      if (retentionDays === undefined) throw new AppError("BUSINESS_INVARIANT", "no customer retention period is set for this store");
      const cutoffMs = appliedMs - retentionDays * 86_400_000;
      const due = deps.customers
        .list(request.tenantId)
        .filter((c) => c.anonymizedAt === undefined && !deps.activity.hasOpenOrder(request.tenantId, c.id))
        .map((c) => ({ c, last: Date.parse(deps.activity.lastActivityAt(request.tenantId, c.id) ?? "") }))
        .filter((x) => !Number.isNaN(x.last) && x.last < cutoffMs)
        .sort((a, b) => a.last - b.last || (a.c.id < b.c.id ? -1 : 1));
      const batch = due.slice(0, RETENTION_BATCH_SIZE);
      for (const { c } of batch) {
        anonymizeCustomer(
          { customers: deps.customers, customerChanges: deps.customerChanges, idempotency: deps.idempotency, ...(deps.now ? { now: deps.now } : {}) },
          { tenantId: request.tenantId, customerId: c.id, expectedVersion: c.version, actorRole: request.actorRole, anonymizedBy: request.appliedBy, anonymizedAt: request.appliedAt, idempotencyKey: `${request.idempotencyKey}:${c.id}` },
        );
      }
      return { retentionDays, cutoff: new Date(cutoffMs).toISOString(), anonymizedCustomerIds: batch.map((x) => x.c.id).sort(), hasMore: due.length > batch.length };
    },
  );
}
