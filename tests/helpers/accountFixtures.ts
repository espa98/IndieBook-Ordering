import type { Account, EmailVerification, VerificationConsumption } from "../../src/auth/accounts";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";

/** 인메모리 계정·인증 토큰 저장소와 고정 토큰·시각 */
export function accountScene(startAt = "2026-03-04T07:00:00.000Z") {
  const accounts: Account[] = [];
  const verifications: EmailVerification[] = [];
  const consumptions: VerificationConsumption[] = [];
  let current = new Date(startAt);
  let tokenSeq = 0;
  const deps = {
    accounts: {
      get: (userId: string) => accounts.find((a) => a.userId === userId),
      findByEmail: (email: string) => accounts.find((a) => a.email === email),
      save: (a: Account) => {
        const i = accounts.findIndex((x) => x.userId === a.userId);
        if (i >= 0) accounts[i] = a;
        else accounts.push(a);
      },
    },
    emailVerifications: {
      findByTokenHash: (hash: string) => verifications.find((v) => v.tokenHash === hash),
      save: (v: EmailVerification) => void verifications.push(v),
    },
    verificationConsumptions: {
      has: (verificationId: string) => consumptions.some((c) => c.verificationId === verificationId),
      save: (c: VerificationConsumption) => void consumptions.push(c),
    },
    generateToken: () => `verify-token-${++tokenSeq}`,
    idempotency: createIdempotencyStore(),
    now: () => current,
  };
  const advance = (ms: number) => void (current = new Date(current.getTime() + ms));
  return { deps, accounts, verifications, consumptions, advance };
}
