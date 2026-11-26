import { describe, it, expect } from "vitest";
import { deactivateStore, type DeactivateStoreRequest } from "../../src/auth/deactivateStore";
import { storeStatusScene } from "../helpers/storeStatusFixtures";

const request = (key: string, extra: Partial<DeactivateStoreRequest> = {}): DeactivateStoreRequest => ({
  tenantId: "tenant-a",
  kind: "SUSPENDED",
  reason: "폐업 준비 중 일시 중단",
  actorRole: "OWNER",
  changedBy: "owner-1",
  changedAt: "2026-03-04T06:30:00.000Z",
  idempotencyKey: key,
  ...extra,
});

describe("deactivateStore: 서점 중지·해지 (ST-A06, ST-A07)", () => {
  it("Owner가 서점을 중지하면 상태가 SUSPENDED로 바뀌고 변경 전·후와 사유·담당자·시각이 이력에 남는다(다른 서점은 그대로)", () => {
    const { deps, statuses, changes, key } = storeStatusScene();

    const change = deactivateStore(deps, request(key()));

    expect(change).toEqual({ id: expect.any(String), tenantId: "tenant-a", kind: "DEACTIVATED", from: "ACTIVE", to: "SUSPENDED", reason: "폐업 준비 중 일시 중단", by: "owner-1", at: "2026-03-04T06:30:00.000Z" });
    expect(changes).toEqual([change]);
    expect(statuses.get("tenant-a")).toBe("SUSPENDED");
    expect(statuses.get("tenant-b")).toBe("ACTIVE");
  });

  it("해지(TERMINATED)도 같은 방식이고, 이미 중지·해지된 서점에는 다시 할 수 없다(BUSINESS_INVARIANT)", () => {
    const { deps, statuses, changes, key } = storeStatusScene();

    deactivateStore(deps, request(key(), { kind: "TERMINATED", reason: "폐업" }));
    expect(statuses.get("tenant-a")).toBe("TERMINATED");

    for (const kind of ["SUSPENDED", "TERMINATED"] as const) {
      expect(() => deactivateStore(deps, request(key(), { kind })), kind).toThrow(/BUSINESS_INVARIANT/);
    }
    expect(changes).toHaveLength(1);
  });

  it("Staff는 FORBIDDEN, 없는 서점은 NOT_FOUND이고 아무것도 바뀌지 않는다", () => {
    const { deps, statuses, changes, key } = storeStatusScene();

    expect(() => deactivateStore(deps, request(key(), { actorRole: "STAFF" }))).toThrow(/FORBIDDEN/);
    expect(() => deactivateStore(deps, request(key(), { tenantId: "nope" }))).toThrow(/NOT_FOUND/);
    expect(statuses.get("tenant-a")).toBe("ACTIVE");
    expect(changes).toHaveLength(0);
  });

  it("종류·사유·담당자·시각 형식이 틀리면 VALIDATION_ERROR이다", () => {
    const { deps, changes, key } = storeStatusScene();

    for (const bad of [{ kind: "CLOSED" }, { kind: undefined }, { reason: " " }, { reason: "가".repeat(501) }, { changedBy: "" }, { changedAt: "2999-01-01T00:00:00.000Z" }] as Partial<DeactivateStoreRequest>[]) {
      expect(() => deactivateStore(deps, request(key(), bad)), JSON.stringify(bad)).toThrow(/VALIDATION_ERROR/);
    }
    expect(changes).toHaveLength(0);
  });

  it("같은 멱등 키·같은 본문은 한 번만 반영하고 다른 본문은 IDEMPOTENCY_CONFLICT이다", () => {
    const { deps, changes } = storeStatusScene();

    const first = deactivateStore(deps, request("same"));
    expect(deactivateStore(deps, request("same"))).toEqual(first);
    expect(() => deactivateStore(deps, request("same", { kind: "TERMINATED" }))).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(changes).toHaveLength(1);
  });
});
