import { describe, it, expect } from "vitest";
import { applyCustomerRetention, type ApplyCustomerRetentionRequest } from "../../src/customer/applyCustomerRetention";
import { RETENTION_BATCH_SIZE } from "../../src/customer/applyCustomerRetention";
import { registerCustomer } from "../../src/customer/registerCustomer";
import { customerScene } from "../helpers/customerFixtures";

const NOW = "2026-06-01T00:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

function retentionScene(retentionDays: number | null = 30) {
  const scene = customerScene();
  const make = (name: string, phone: string, idle: number) => ({ customer: registerCustomer(scene.deps, scene.request({ name, phone })).customer, lastActivityAt: daysAgo(idle) });
  const fresh = make("최근고객", "010-1000-0001", 10);
  const edge = make("경계고객", "010-1000-0002", 30);
  const stale = make("오래된고객", "010-1000-0003", 31);
  const ancient = make("아주오래된", "010-1000-0004", 400);
  const activity = new Map([fresh, edge, stale, ancient].map((x) => [x.customer.id, x.lastActivityAt]));
  const deps = {
    customers: scene.deps.customers,
    customerChanges: scene.deps.customerChanges,
    stores: { getRetentionDays: (tenantId: string) => (tenantId === "tenant-a" ? retentionDays ?? undefined : undefined) },
    activity: { lastActivityAt: (_t: string, id: string) => activity.get(id) },
    idempotency: scene.deps.idempotency,
    now: () => new Date(NOW),
  };
  let seq = 0;
  const apply = (extra: Partial<ApplyCustomerRetentionRequest> = {}): ApplyCustomerRetentionRequest => ({
    tenantId: "tenant-a",
    actorRole: "OWNER",
    appliedBy: "owner-1",
    appliedAt: NOW,
    idempotencyKey: `ret-${++seq}`,
    ...extra,
  });
  return { ...scene, deps, fresh, edge, stale, ancient, apply };
}

describe("applyCustomerRetention: 보존기간이 지난 고객 익명화 (고객 결정 #2, Owner 재량)", () => {
  it("마지막 활동 뒤 보존기간(일)을 넘긴 고객만 익명화하고(정확히 기한인 고객은 아직 아님), 이력에 Owner가 남는다", () => {
    const { deps, changes, customers, fresh, edge, stale, ancient, apply } = retentionScene(30);

    const result = applyCustomerRetention(deps, apply());

    expect(result).toEqual({ retentionDays: 30, cutoff: daysAgo(30), anonymizedCustomerIds: [stale.customer.id, ancient.customer.id].sort(), hasMore: false });
    expect(customers.filter((c) => c.anonymizedAt !== undefined).map((c) => c.id).sort()).toEqual(result.anonymizedCustomerIds);
    expect(customers.find((c) => c.id === fresh.customer.id)!.anonymizedAt).toBeUndefined();
    expect(customers.find((c) => c.id === edge.customer.id)!.anonymizedAt).toBeUndefined();
    expect(changes.filter((c) => c.kind === "ANONYMIZED").map((c) => c.by)).toEqual(["owner-1", "owner-1"]);
  });

  it("보존기간이 없으면 BUSINESS_INVARIANT이고 형식 오류(행위자·시각)는 VALIDATION_ERROR이며 아무것도 익명화하지 않는다", () => {
    const none = retentionScene(null);
    const ok = retentionScene(30);

    expect(() => applyCustomerRetention(none.deps, none.apply())).toThrow(/BUSINESS_INVARIANT/);
    expect(() => applyCustomerRetention(ok.deps, ok.apply({ appliedBy: "" }))).toThrow(/VALIDATION_ERROR/);
    expect(() => applyCustomerRetention(ok.deps, ok.apply({ appliedAt: "2999-01-01T00:00:00.000Z" }))).toThrow(/VALIDATION_ERROR/);
    expect([...none.customers, ...ok.customers].some((c) => c.anonymizedAt !== undefined)).toBe(false);
  });

  it("같은 멱등 키로 다시 보내면 같은 결과이고 이력이 늘지 않으며, 새 키로 다시 실행하면 더 처리할 것이 없다", () => {
    const { deps, changes, apply } = retentionScene(30);
    const first = applyCustomerRetention(deps, apply({ idempotencyKey: "same" }));
    const count = changes.length;

    expect(applyCustomerRetention(deps, apply({ idempotencyKey: "same" }))).toEqual(first);
    expect(changes).toHaveLength(count);
    expect(applyCustomerRetention(deps, apply())).toMatchObject({ anonymizedCustomerIds: [], hasMore: false });
  });

  it(`한 번에 ${100}명까지 오래된 순으로 처리하고 남으면 hasMore이며, 다시 실행하면 나머지를 이어서 처리한다`, () => {
    const { deps, customers, request, apply } = retentionScene(30);
    const activity = new Map<string, string>();
    for (let i = 0; i < RETENTION_BATCH_SIZE + 1; i++) {
      const c = registerCustomer(deps, request({ name: `대량${i}`, phone: `010-2${String(i).padStart(3, "0")}-0000` })).customer;
      activity.set(c.id, daysAgo(100 + i));
    }
    const base = deps.activity.lastActivityAt;
    deps.activity = { lastActivityAt: (t, id) => activity.get(id) ?? base(t, id) };

    const first = applyCustomerRetention(deps, apply());
    const second = applyCustomerRetention(deps, apply());

    expect(RETENTION_BATCH_SIZE).toBe(100);
    expect(first.hasMore).toBe(true);
    expect(first.anonymizedCustomerIds).toHaveLength(100);
    expect(second.hasMore).toBe(false);
    expect(first.anonymizedCustomerIds.length + second.anonymizedCustomerIds.length).toBe(customers.filter((c) => c.anonymizedAt !== undefined).length);
    expect(customers.filter((c) => c.anonymizedAt === undefined).map((c) => c.name).sort()).toEqual(["경계고객", "최근고객"]);
  });
});
