import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString } from "../procurement/validation";
import type { AccountPrincipal } from "./accountPrincipal";
import type { Membership, MembershipRepository } from "./authorizeTenantAccess";

const MAX_STORE_NAME_LENGTH = 60;
/** 한 계정이 소유할 수 있는 서점 수 상한(사용자 결정 2026-11-25). 남용 방지 */
export const MAX_STORES_PER_OWNER = 99;

/** 서점(테넌트). 중지·해지(ST-A06/A07)는 아직 없어 ACTIVE만 있다. */
export type Tenant = {
  id: string;
  name: string;
  status: "ACTIVE";
  ownerUserId: string;
  createdAt: string;
};

export type OpenStoreDeps = {
  tenants: {
    get(id: string): Tenant | undefined;
    listByOwner(userId: string): Tenant[];
    save(tenant: Tenant): void;
  };
  memberships: MembershipRepository & { save(membership: Membership): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type OpenStoreRequest = {
  storeName: string;
  idempotencyKey: string;
};

/**
 * 이메일을 인증한 계정이 서점을 연다 (ST-A02). 서점과 Owner 멤버십은 함께 만들어진다.
 * 같은 멱등 키의 재시도는 같은 결과를 돌려주고, 같은 소유자의 같은 이름은 중복으로 거부한다.
 */
export function openStore(
  deps: OpenStoreDeps,
  principal: AccountPrincipal,
  request: OpenStoreRequest,
): { tenant: Tenant; membership: Membership } {
  if (!principal.verified) {
    throw new AppError("FORBIDDEN");
  }
  if (!isNonEmptyString(request.storeName) || request.storeName.trim().length > MAX_STORE_NAME_LENGTH) {
    invalid("storeName", `must be a non-empty string up to ${MAX_STORE_NAME_LENGTH} characters`);
  }
  const name = request.storeName.trim();
  const now = (deps.now ?? (() => new Date()))();
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: "-",
      operation: "auth.open-store",
      key: `${principal.userId}:${request.idempotencyKey}`,
      payload: { name },
    },
    () => {
      const owned = deps.tenants.listByOwner(principal.userId);
      if (owned.length >= MAX_STORES_PER_OWNER) {
        throw new AppError("BUSINESS_INVARIANT", `an owner can open at most ${MAX_STORES_PER_OWNER} stores`);
      }
      if (owned.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        throw new AppError("BUSINESS_INVARIANT", "the owner already has a store with this name");
      }
      const tenant: Tenant = {
        id: crypto.randomUUID(),
        name,
        status: "ACTIVE",
        ownerUserId: principal.userId,
        createdAt: now.toISOString(),
      };
      const membership: Membership = {
        userId: principal.userId,
        tenantId: tenant.id,
        role: "OWNER",
        status: "ACTIVE",
      };
      // 검증을 모두 마친 뒤 연속 저장한다. 저장 도중 실패를 되돌리는 보장은 없다
      deps.tenants.save(tenant);
      deps.memberships.save(membership);
      return { tenant, membership };
    },
  );
}
