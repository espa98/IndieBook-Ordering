import { describe, it, expect } from "vitest";
import { registerAccount, verifyEmail } from "../../src/auth/accounts";
import type { Membership } from "../../src/auth/authorizeTenantAccess";
import { resolveAccountPrincipal } from "../../src/auth/accountPrincipal";
import { openStore } from "../../src/auth/openStore";
import type { Tenant } from "../../src/auth/openStore";
import { resolvePrincipal } from "../../src/auth/principal";
import { AppError } from "../../src/errors/AppError";
import { accountScene } from "../helpers/accountFixtures";

const FUTURE = "2026-03-04T08:00:00.000Z";
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
};

function storeScene() {
  const s = accountScene();
  const tenants: Tenant[] = [];
  const members: Membership[] = [];
  const memberships = {
    find: (userId: string, tenantId: string) => members.find((m) => m.userId === userId && m.tenantId === tenantId),
    save: (m: Membership) => void members.push(m),
  };
  const deps = {
    ...s.deps,
    tenants: {
      get: (id: string) => tenants.find((t) => t.id === id),
      listByOwner: (userId: string) => tenants.filter((t) => t.ownerUserId === userId),
      save: (t: Tenant) => void tenants.push(t),
    },
    memberships,
  };
  const signUp = (userId: string, email: string, verify: boolean) => {
    const { token } = registerAccount(deps, { userId, email, idempotencyKey: `reg-${userId}` });
    if (verify) verifyEmail(deps, { token, idempotencyKey: `ver-${userId}` });
  };
  const principalOf = (userId: string) => resolveAccountPrincipal(deps, { userId, sessionExpiresAt: FUTURE });
  return { ...s, deps, tenants, members, signUp, principalOf };
}

describe("resolveAccountPrincipal: 계정 주체 (ST-A08)", () => {
  it("세션이 유효하면 계정 주체를 만들고 이메일 인증 여부를 담으며, 만료·미등록 계정은 UNAUTHENTICATED이다", () => {
    const { deps, signUp, principalOf } = storeScene();
    signUp("u-1", "a@example.com", true);
    signUp("u-2", "b@example.com", false);

    expect(principalOf("u-1")).toEqual({ kind: "ACCOUNT", userId: "u-1", email: "a@example.com", verified: true });
    expect(principalOf("u-2")).toMatchObject({ verified: false });
    expect(codeOf(() => principalOf("ghost"))).toBe("UNAUTHENTICATED");
    expect(codeOf(() => resolveAccountPrincipal(deps, { userId: "u-1", sessionExpiresAt: "2026-03-04T07:00:00.000Z" }))).toBe("UNAUTHENTICATED");
    expect(codeOf(() => resolveAccountPrincipal(deps, { userId: "u-1", sessionExpiresAt: "bad" }))).toBe("UNAUTHENTICATED");
  });
});

describe("openStore: 서점 개설 (ST-A02, AUTH-002)", () => {
  it("인증된 계정이 서점을 열면 활성 Tenant와 Owner 멤버십이 함께 만들어지고, 그 멤버십으로 바로 주체를 도출할 수 있다", () => {
    const { deps, tenants, members, signUp, principalOf } = storeScene();
    signUp("u-1", "a@example.com", true);

    const { tenant, membership } = openStore(deps, principalOf("u-1"), { storeName: "책방, 오후 세시", idempotencyKey: "open-1" });

    expect(tenant).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "책방, 오후 세시",
      status: "ACTIVE",
      ownerUserId: "u-1",
      createdAt: "2026-03-04T07:00:00.000Z",
    });
    expect(membership).toEqual({ userId: "u-1", tenantId: tenant.id, role: "OWNER", status: "ACTIVE" });
    expect(tenants).toEqual([tenant]);
    expect(members).toEqual([membership]);
    expect(
      resolvePrincipal({ memberships: deps.memberships, now: deps.now }, { userId: "u-1", tenantId: tenant.id, sessionExpiresAt: FUTURE }),
    ).toMatchObject({ role: "OWNER", tenantId: tenant.id });
  });

  it("같은 멱등 키로 재시도해도 서점은 하나만 만들어지고, 다른 키라도 같은 소유자의 같은 이름은 중복으로 거부한다", () => {
    const { deps, tenants, members, signUp, principalOf } = storeScene();
    signUp("u-1", "a@example.com", true);
    const p = principalOf("u-1");

    const first = openStore(deps, p, { storeName: "책방", idempotencyKey: "open-1" });
    const retry = openStore(deps, p, { storeName: "책방", idempotencyKey: "open-1" });

    expect(retry).toEqual(first);
    expect(tenants).toHaveLength(1);
    expect(members).toHaveLength(1);
    expect(codeOf(() => openStore(deps, p, { storeName: " 책방 ", idempotencyKey: "open-2" }))).toBe("BUSINESS_INVARIANT");
    expect(codeOf(() => openStore(deps, p, { storeName: "다른 책방", idempotencyKey: "open-3" }))).toBeUndefined(); // 이름이 다르면 허용
    expect(tenants).toHaveLength(2);
  });

  it("이메일을 인증하지 않은 계정은 FORBIDDEN 403이고, 서점 이름이 비었거나 60자를 넘으면 VALIDATION_ERROR 400이며, 아무것도 만들어지지 않는다", () => {
    const { deps, tenants, members, signUp, principalOf } = storeScene();
    signUp("u-1", "a@example.com", false);
    signUp("u-2", "b@example.com", true);

    expect(codeOf(() => openStore(deps, principalOf("u-1"), { storeName: "책방", idempotencyKey: "o-1" }))).toBe("FORBIDDEN");
    expect(codeOf(() => openStore(deps, principalOf("u-2"), { storeName: " ", idempotencyKey: "o-2" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => openStore(deps, principalOf("u-2"), { storeName: "가".repeat(61), idempotencyKey: "o-3" }))).toBe("VALIDATION_ERROR");
    expect(tenants).toEqual([]);
    expect(members).toEqual([]);
  });

  it("한 소유자는 서점을 99개까지만 열 수 있고, 100번째는 BUSINESS_INVARIANT이며 다른 소유자·이미 연 서점의 재시도에는 영향이 없다", () => {
    const { deps, tenants, signUp, principalOf } = storeScene();
    signUp("u-1", "a@example.com", true);
    signUp("u-2", "b@example.com", true);
    const p = principalOf("u-1");

    for (let n = 1; n <= 99; n++) openStore(deps, p, { storeName: `서점 ${n}`, idempotencyKey: `cap-${n}` });
    expect(tenants.filter((t) => t.ownerUserId === "u-1")).toHaveLength(99);

    expect(codeOf(() => openStore(deps, p, { storeName: "서점 100", idempotencyKey: "cap-100" }))).toBe("BUSINESS_INVARIANT");
    expect(tenants).toHaveLength(99); // 거부는 아무것도 만들지 않는다
    expect(openStore(deps, p, { storeName: "서점 99", idempotencyKey: "cap-99" }).tenant.name).toBe("서점 99"); // 같은 키의 재시도는 기존 결과
    expect(codeOf(() => openStore(deps, principalOf("u-2"), { storeName: "서점 1", idempotencyKey: "other-1" }))).toBeUndefined(); // 다른 소유자
  });
});
