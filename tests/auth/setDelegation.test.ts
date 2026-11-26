import { describe, it, expect } from "vitest";
import type { Membership } from "../../src/auth/authorizeTenantAccess";
import { setDelegation, type DelegationChange, type DelegationKind } from "../../src/auth/setDelegation";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { thrown } from "../helpers/thrown";

const NOW = new Date("2026-03-04T07:00:00.000Z");

/** Owner가 직원에게 공급처·템플릿 관리(MANAGEMENT)나 재고 조정(STOCK_ADJUSTMENT)을 위임하거나 거둔다 (STBR "O/위임 S", S-03) */
function scene() {
  const members: Membership[] = [
    { userId: "owner-1", tenantId: "tenant-a", role: "OWNER", status: "ACTIVE" },
    { userId: "staff-1", tenantId: "tenant-a", role: "STAFF", status: "ACTIVE" },
    { userId: "staff-2", tenantId: "tenant-a", role: "STAFF", status: "INACTIVE" },
    { userId: "staff-b", tenantId: "tenant-b", role: "STAFF", status: "ACTIVE" },
  ];
  const granted = new Set<string>();
  const changes: DelegationChange[] = [];
  const deps = {
    memberships: { find: (userId: string, tenantId: string) => members.find((m) => m.userId === userId && m.tenantId === tenantId) },
    delegations: {
      isDelegated: (tenantId: string, userId: string, kind: DelegationKind) => granted.has(`${tenantId}/${userId}/${kind}`),
      save: (c: DelegationChange) => {
        changes.push(c);
        const key = `${c.tenantId}/${c.userId}/${c.kind}`;
        if (c.delegated) granted.add(key);
        else granted.delete(key);
      },
    },
    idempotency: createIdempotencyStore(),
    now: () => NOW,
  };
  let seq = 0;
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    targetUserId: "staff-1",
    kind: "MANAGEMENT" as DelegationKind,
    delegated: true,
    actorRole: "OWNER" as const,
    changedBy: "owner-1",
    idempotencyKey: `deleg-${++seq}`,
    ...extra,
  });
  return { deps, granted, changes, request };
}

describe("setDelegation: 위임 부여·회수 (S-03)", () => {
  it("Owner가 활성 직원에게 위임을 부여하면 위임 상태가 바뀌고 변경 기록(누가·언제·무엇)이 남는다", () => {
    const { deps, granted, changes, request } = scene();

    const change = setDelegation(deps, request());

    expect(change).toEqual({
      id: expect.any(String), tenantId: "tenant-a", userId: "staff-1", kind: "MANAGEMENT", delegated: true, changedBy: "owner-1", changedAt: NOW.toISOString(),
    });
    expect(granted.has("tenant-a/staff-1/MANAGEMENT")).toBe(true);
    expect(granted.has("tenant-a/staff-1/STOCK_ADJUSTMENT")).toBe(false); // 종류별로 독립이다
    expect(changes).toEqual([change]);
  });

  it("Staff는 FORBIDDEN이고, 대상이 서점 멤버가 아니면(다른 서점 직원 포함) NOT_FOUND, Owner이거나 비활성 직원에게 부여하는 것은 BUSINESS_INVARIANT이며 아무것도 바뀌지 않는다", () => {
    const { deps, granted, changes, request } = scene();

    expect(thrown(() => setDelegation(deps, request({ actorRole: "STAFF" })))).toMatchObject({ code: "FORBIDDEN" });
    expect(thrown(() => setDelegation(deps, request({ targetUserId: "nobody" })))).toMatchObject({ code: "NOT_FOUND" });
    expect(thrown(() => setDelegation(deps, request({ targetUserId: "staff-b" })))).toMatchObject({ code: "NOT_FOUND" });
    expect(thrown(() => setDelegation(deps, request({ targetUserId: "owner-1" })))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(thrown(() => setDelegation(deps, request({ targetUserId: "staff-2" })))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(granted.size).toBe(0);
    expect(changes).toEqual([]);
  });

  it("이미 그 상태면 BUSINESS_INVARIANT이고, 회수하면 위임이 사라지며(기록은 남는다), 비활성 직원의 위임도 회수할 수 있다", () => {
    const { deps, granted, changes, request } = scene();
    setDelegation(deps, request());
    expect(thrown(() => setDelegation(deps, request()))).toMatchObject({ code: "BUSINESS_INVARIANT" }); // 이미 부여됨
    expect(thrown(() => setDelegation(deps, request({ delegated: false, kind: "STOCK_ADJUSTMENT" })))).toMatchObject({ code: "BUSINESS_INVARIANT" }); // 부여된 적 없음

    const revoked = setDelegation(deps, request({ delegated: false }));
    expect(revoked).toMatchObject({ delegated: false, kind: "MANAGEMENT" });
    expect(granted.size).toBe(0);
    expect(changes.map((c) => c.delegated)).toEqual([true, false]);

    // 비활성이 된 직원에게 남은 위임은 거둘 수 있다
    granted.add("tenant-a/staff-2/STOCK_ADJUSTMENT");
    expect(setDelegation(deps, request({ targetUserId: "staff-2", kind: "STOCK_ADJUSTMENT", delegated: false })).delegated).toBe(false);
  });

  it("kind·delegated·changedBy가 잘못되면 VALIDATION_ERROR이고, 같은 멱등 키·같은 본문은 한 번만 반영하며 다른 본문은 IDEMPOTENCY_CONFLICT이다", () => {
    const { deps, changes, request } = scene();
    for (const bad of [{ kind: "ALL" }, { kind: undefined }, { delegated: "true" }, { delegated: undefined }, { changedBy: " " }]) {
      expect(thrown(() => setDelegation(deps, request(bad))), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(changes).toEqual([]);

    const first = setDelegation(deps, request({ idempotencyKey: "same" }));
    expect(setDelegation(deps, request({ idempotencyKey: "same" }))).toEqual(first);
    expect(changes).toHaveLength(1);
    expect(thrown(() => setDelegation(deps, request({ idempotencyKey: "same", kind: "STOCK_ADJUSTMENT" })))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
