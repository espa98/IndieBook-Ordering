import { describe, it, expect } from "vitest";
import { deactivateStore } from "../../src/auth/deactivateStore";
import { reactivateStore, type ReactivateStoreRequest } from "../../src/auth/reactivateStore";
import { storeStatusScene } from "../helpers/storeStatusFixtures";

const approve = (key: string, extra: Partial<ReactivateStoreRequest> = {}): ReactivateStoreRequest => ({
  storeId: "tenant-a",
  reason: "운영자 확인 완료: 사업자 정보 재확인",
  adminUserId: "admin-1",
  approvedAt: "2026-03-04T06:45:00.000Z",
  idempotencyKey: key,
  ...extra,
});
const suspended = () => {
  const scene = storeStatusScene();
  deactivateStore(scene.deps, { tenantId: "tenant-a", kind: "SUSPENDED", reason: "중단", actorRole: "OWNER", changedBy: "owner-1", changedAt: "2026-03-04T06:30:00.000Z", idempotencyKey: "d-1" });
  return scene;
};

describe("reactivateStore: 운영자 승인으로 서점 재사용", () => {
  it("운영자가 중지된 서점을 승인하면 ACTIVE로 돌아오고 승인한 운영자·사유·시각이 이력에 남는다", () => {
    const { deps, statuses, changes, key } = suspended();

    const change = reactivateStore(deps, approve(key()));

    expect(change).toEqual({ id: expect.any(String), tenantId: "tenant-a", kind: "REACTIVATED", from: "SUSPENDED", to: "ACTIVE", reason: "운영자 확인 완료: 사업자 정보 재확인", by: "admin-1", at: "2026-03-04T06:45:00.000Z" });
    expect(statuses.get("tenant-a")).toBe("ACTIVE");
    expect(changes.map((c) => c.kind)).toEqual(["DEACTIVATED", "REACTIVATED"]);
  });

  it("해지된 서점도 승인으로 돌아올 수 있고, 이미 사용 중인 서점은 BUSINESS_INVARIANT, 없는 서점은 NOT_FOUND이다", () => {
    const { deps, statuses, changes, key } = storeStatusScene({ "tenant-a": "TERMINATED", "tenant-b": "ACTIVE" });

    expect(() => reactivateStore(deps, approve(key(), { storeId: "tenant-b" }))).toThrow(/BUSINESS_INVARIANT/);
    expect(() => reactivateStore(deps, approve(key(), { storeId: "nope" }))).toThrow(/NOT_FOUND/);
    expect(changes).toHaveLength(0);

    expect(reactivateStore(deps, approve(key())).from).toBe("TERMINATED");
    expect(statuses.get("tenant-a")).toBe("ACTIVE");
  });

  it("사유·운영자·시각 형식이 틀리면 VALIDATION_ERROR이고, 같은 멱등 키는 한 번만 반영한다", () => {
    const { deps, changes, key } = suspended();
    const before = changes.length;

    for (const bad of [{ reason: " " }, { reason: "가".repeat(501) }, { adminUserId: "" }, { approvedAt: "2999-01-01T00:00:00.000Z" }] as Partial<ReactivateStoreRequest>[]) {
      expect(() => reactivateStore(deps, approve(key(), bad)), JSON.stringify(bad)).toThrow(/VALIDATION_ERROR/);
    }
    expect(changes).toHaveLength(before);

    const first = reactivateStore(deps, approve("same"));
    expect(reactivateStore(deps, approve("same"))).toEqual(first);
    expect(() => reactivateStore(deps, approve("same", { reason: "다른 사유" }))).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(changes).toHaveLength(before + 1);
  });
});
