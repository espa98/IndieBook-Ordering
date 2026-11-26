import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type { StoreStatus, StoreStatusChange } from "../../src/auth/deactivateStore";

/** 서점 상태 변경 시험용 장면: 서점 상태 저장소와 변경 이력 */
export function storeStatusScene(initial: Record<string, StoreStatus> = { "tenant-a": "ACTIVE", "tenant-b": "ACTIVE" }) {
  const statuses = new Map<string, StoreStatus>(Object.entries(initial));
  const changes: StoreStatusChange[] = [];
  const deps = {
    stores: {
      getStatus: (tenantId: string) => statuses.get(tenantId),
      apply: (change: StoreStatusChange, next: StoreStatus) => {
        changes.push(change);
        statuses.set(change.tenantId, next);
      },
    },
    idempotency: createIdempotencyStore(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const key = () => `st-${++seq}`;
  return { deps, statuses, changes, key };
}
