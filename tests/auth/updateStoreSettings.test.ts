import { describe, it, expect } from "vitest";
import { updateStoreSettings, type StoreSettings, type StoreSettingsChange } from "../../src/auth/updateStoreSettings";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { thrown } from "../helpers/thrown";

const NOW = new Date("2026-03-04T07:00:00.000Z");

/** 서점 기본정보(S-01)와 미수령 경고일(S-07, DEC-07 서점별 기본 7일) 변경 */
function scene() {
  const stores: StoreSettings[] = [
    { id: "tenant-a", name: "책방 오후 세시", ownerUserId: "owner-1", longUnreceivedWarningDays: 7 },
    { id: "tenant-b", name: "두번째 서점", ownerUserId: "owner-1", longUnreceivedWarningDays: 7 },
    { id: "tenant-c", name: "Other Owner Store", ownerUserId: "owner-2", longUnreceivedWarningDays: 7 },
  ];
  const changes: StoreSettingsChange[] = [];
  const deps = {
    stores: {
      get: (id: string) => stores.find((s) => s.id === id),
      listByOwner: (ownerUserId: string) => stores.filter((s) => s.ownerUserId === ownerUserId),
      apply: (change: StoreSettingsChange, next: StoreSettings) => {
        changes.push(change);
        const i = stores.findIndex((s) => s.id === next.id);
        stores[i] = next;
      },
    },
    idempotency: createIdempotencyStore(),
    now: () => NOW,
  };
  let seq = 0;
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    name: "새 이름",
    actorRole: "OWNER" as const,
    changedBy: "owner-1",
    idempotencyKey: `settings-${++seq}`,
    ...extra,
  });
  return { deps, stores, changes, request };
}

describe("updateStoreSettings: 서점 기본정보·미수령 경고일 변경 (S-01, S-07)", () => {
  it("Owner가 이름이나 경고일을 바꾸면 값이 바뀌고 바뀐 항목의 전·후 값과 담당자·시각이 기록된다(바꾸지 않은 항목은 그대로)", () => {
    const { deps, stores, changes, request } = scene();

    const change = updateStoreSettings(deps, request({ name: "  새 이름  " }));

    expect(change).toEqual({
      id: expect.any(String), tenantId: "tenant-a", changedBy: "owner-1", changedAt: NOW.toISOString(),
      changes: { name: { from: "책방 오후 세시", to: "새 이름" } },
    });
    expect(stores.find((s) => s.id === "tenant-a")).toMatchObject({ name: "새 이름", longUnreceivedWarningDays: 7 });

    const days = updateStoreSettings(deps, request({ name: undefined, longUnreceivedWarningDays: 14 }));
    expect(days.changes).toEqual({ longUnreceivedWarningDays: { from: 7, to: 14 } });
    expect(stores.find((s) => s.id === "tenant-a")).toMatchObject({ name: "새 이름", longUnreceivedWarningDays: 14 });

    const both = updateStoreSettings(deps, request({ name: "또 새 이름", longUnreceivedWarningDays: 3 }));
    expect(Object.keys(both.changes).sort()).toEqual(["longUnreceivedWarningDays", "name"]);
    expect(changes).toHaveLength(3);
  });

  it("Staff는 FORBIDDEN, 없는 서점은 NOT_FOUND이고 아무것도 바뀌지 않는다", () => {
    const { deps, stores, changes, request } = scene();
    const before = JSON.stringify(stores);
    expect(thrown(() => updateStoreSettings(deps, request({ actorRole: "STAFF" })))).toMatchObject({ code: "FORBIDDEN" });
    expect(thrown(() => updateStoreSettings(deps, request({ tenantId: "nope" })))).toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(stores)).toBe(before);
    expect(changes).toEqual([]);
  });

  it("바꿀 항목이 없거나 이름·경고일이 잘못되면 VALIDATION_ERROR이다(이름 1~60자, 경고일 1~365 정수)", () => {
    const { deps, changes, request } = scene();
    for (const bad of [
      { name: undefined }, { name: "   " }, { name: "가".repeat(61) }, { name: 5 },
      { name: undefined, longUnreceivedWarningDays: 0 }, { name: undefined, longUnreceivedWarningDays: 366 }, { name: undefined, longUnreceivedWarningDays: 1.5 }, { name: undefined, longUnreceivedWarningDays: "7" },
      { changedBy: " " },
    ]) {
      expect(thrown(() => updateStoreSettings(deps, request(bad))), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(changes).toEqual([]);
  });

  it("같은 값으로 바꾸려 하거나 같은 소유자의 다른 서점 이름과 겹치면 BUSINESS_INVARIANT이다(다른 소유자와는 겹쳐도 된다, 대소문자 무시)", () => {
    const { deps, changes, request } = scene();
    expect(thrown(() => updateStoreSettings(deps, request({ name: "책방 오후 세시" })))).toMatchObject({ code: "BUSINESS_INVARIANT" }); // 변경 없음
    expect(thrown(() => updateStoreSettings(deps, request({ name: undefined, longUnreceivedWarningDays: 7 })))).toMatchObject({ code: "BUSINESS_INVARIANT" });
    expect(thrown(() => updateStoreSettings(deps, request({ name: "두번째 서점" })))).toMatchObject({ code: "BUSINESS_INVARIANT" }); // 같은 소유자의 다른 서점
    expect(thrown(() => updateStoreSettings(deps, request({ tenantId: "tenant-b", name: "책방 오후 세시" })))).toMatchObject({ code: "BUSINESS_INVARIANT" }); // 같은 소유자의 tenant-a 이름
    expect(changes).toEqual([]);
    // 다른 소유자의 서점(tenant-c)과 같은 이름은 상관없다
    expect(updateStoreSettings(deps, request({ tenantId: "tenant-b", name: "OTHER OWNER STORE" })).changes.name).toEqual({ from: "두번째 서점", to: "OTHER OWNER STORE" });
  });

  it("같은 멱등 키·같은 본문은 한 번만 반영하고 다른 본문은 IDEMPOTENCY_CONFLICT이다", () => {
    const { deps, changes, request } = scene();
    const first = updateStoreSettings(deps, request({ idempotencyKey: "same" }));
    expect(updateStoreSettings(deps, request({ idempotencyKey: "same" }))).toEqual(first);
    expect(changes).toHaveLength(1);
    expect(thrown(() => updateStoreSettings(deps, request({ idempotencyKey: "same", name: "다른 이름" })))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
