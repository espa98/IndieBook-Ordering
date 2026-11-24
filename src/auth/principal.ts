import { AppError } from "../errors/AppError";
import { authorizeTenantAccess, type MembershipRepository, type Role } from "./authorizeTenantAccess";

/** 서버가 신원에서 도출한 행위 주체. 요청 본문의 값이 아니다. */
export type UserPrincipal = { kind: "USER"; userId: string; tenantId: string; role: Role };
/** 서버 내부 업무(종결 실행 등)의 주체. 외부 요청에서 만들 수 없다. */
export type SystemPrincipal = { kind: "SYSTEM"; tenantId: string };
export type Principal = UserPrincipal | SystemPrincipal;

export type ResolvePrincipalDeps = {
  memberships: MembershipRepository;
  now?: () => Date;
};

export type VerifiedIdentity = {
  userId: string;
  tenantId: string;
  /** 세션·토큰 만료 시각(RFC3339 UTC). 서명 검증은 이 함수 밖에서 끝났다고 본다 */
  sessionExpiresAt: string;
};

/**
 * 검증이 끝난 신원에서 행위 주체를 만든다. 멤버십은 호출마다 다시 읽으므로
 * 직원 비활성화는 즉시 반영된다 (ST-A05).
 */
export function resolvePrincipal(
  deps: ResolvePrincipalDeps,
  identity: VerifiedIdentity,
): UserPrincipal {
  // 만료 시각이 없거나 형식이 틀리거나 이미 지났으면 재인증이 필요하다 (ST-A08)
  const expiresAt =
    typeof identity.sessionExpiresAt === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(identity.sessionExpiresAt)
      ? Date.parse(identity.sessionExpiresAt)
      : Number.NaN;
  if (Number.isNaN(expiresAt) || expiresAt <= (deps.now ?? (() => new Date()))().getTime()) {
    throw new AppError("UNAUTHENTICATED");
  }
  const { role } = authorizeTenantAccess(deps, identity);
  return { kind: "USER", userId: identity.userId, tenantId: identity.tenantId, role };
}

export function createSystemPrincipal(tenantId: string): SystemPrincipal {
  return { kind: "SYSTEM", tenantId };
}
