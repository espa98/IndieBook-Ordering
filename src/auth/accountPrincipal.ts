import { AppError } from "../errors/AppError";
import type { AccountRepository } from "./accounts";

/** 서점에 속하기 전의 로그인 계정 주체. 서점 개설·초대 수락처럼 테넌트가 아직 없는 업무에 쓴다. */
export type AccountPrincipal = {
  kind: "ACCOUNT";
  userId: string;
  email: string;
  /** 이메일 인증 완료 여부 (ST-A01) */
  verified: boolean;
};

export type ResolveAccountPrincipalDeps = {
  accounts: Pick<AccountRepository, "get">;
  now?: () => Date;
};

/** 검증이 끝난 신원에서 계정 주체를 만든다. 세션이 만료되었거나 계정이 없으면 재인증이 필요하다 (ST-A08). */
export function resolveAccountPrincipal(
  deps: ResolveAccountPrincipalDeps,
  identity: { userId: string; sessionExpiresAt: string },
): AccountPrincipal {
  const expiresAt =
    typeof identity.sessionExpiresAt === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(identity.sessionExpiresAt)
      ? Date.parse(identity.sessionExpiresAt)
      : Number.NaN;
  if (Number.isNaN(expiresAt) || expiresAt <= (deps.now ?? (() => new Date()))().getTime()) {
    throw new AppError("UNAUTHENTICATED");
  }
  const account = typeof identity.userId === "string" ? deps.accounts.get(identity.userId) : undefined;
  if (!account) {
    throw new AppError("UNAUTHENTICATED");
  }
  return { kind: "ACCOUNT", userId: account.userId, email: account.email, verified: account.status === "VERIFIED" };
}
