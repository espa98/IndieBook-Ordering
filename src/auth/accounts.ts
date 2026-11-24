import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString } from "../procurement/validation";

/** 이메일 인증 토큰의 유효 시간 */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 3_600_000;

/** 로그인 계정. 비밀번호·자격 증명은 인증 제공자가 관리하며 이 시스템은 저장하지 않는다 (ST-A01). */
export type Account = {
  userId: string;
  /** 소문자로 정규화한 이메일 */
  email: string;
  status: "UNVERIFIED" | "VERIFIED";
  createdAt: string;
  verifiedAt?: string;
};

export type AccountRepository = {
  get(userId: string): Account | undefined;
  findByEmail(email: string): Account | undefined;
  save(account: Account): void;
};

/** 인증 토큰 발급 기록 (추가 전용). 토큰은 해시만 저장한다. */
export type EmailVerification = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

/** 사용된 인증 토큰 기록 (추가 전용). 재사용을 막는다. */
export type VerificationConsumption = {
  verificationId: string;
  userId: string;
  consumedAt: string;
};

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeEmail(email: unknown): string {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    invalid("email", "must be a valid email address");
  }
  return normalized;
}

export type RegisterAccountDeps = {
  accounts: AccountRepository;
  emailVerifications: { save(verification: EmailVerification): void };
  generateToken?: () => string;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RegisterAccountRequest = {
  /** 인증 제공자가 발급한 사용자 ID */
  userId: string;
  email: string;
  idempotencyKey: string;
};

/** 계정을 UNVERIFIED로 등록하고 인증 토큰을 발급한다. 토큰은 이 응답으로만 전달된다 (발송은 호출자의 몫). */
export function registerAccount(
  deps: RegisterAccountDeps,
  request: RegisterAccountRequest,
): { account: Account; token: string } {
  if (!isNonEmptyString(request.userId)) {
    invalid("userId", "must be a non-empty string");
  }
  const email = normalizeEmail(request.email);
  const now = (deps.now ?? (() => new Date()))();
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: "-",
      operation: "auth.register-account",
      key: request.idempotencyKey,
      payload: { userId: request.userId, email },
    },
    () => {
      if (deps.accounts.get(request.userId) || deps.accounts.findByEmail(email)) {
        throw new AppError("BUSINESS_INVARIANT", "an account with this user id or email already exists");
      }
      const account: Account = {
        userId: request.userId,
        email,
        status: "UNVERIFIED",
        createdAt: now.toISOString(),
      };
      const token = (deps.generateToken ?? (() => randomUUID() + randomUUID()))();
      deps.accounts.save(account);
      deps.emailVerifications.save({
        id: crypto.randomUUID(),
        userId: account.userId,
        tokenHash: hashVerificationToken(token),
        createdAt: account.createdAt,
        expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS).toISOString(),
      });
      return { account, token };
    },
  );
}

export type VerifyEmailDeps = {
  accounts: Pick<AccountRepository, "get" | "save">;
  emailVerifications: { findByTokenHash(tokenHash: string): EmailVerification | undefined };
  verificationConsumptions: {
    has(verificationId: string): boolean;
    save(consumption: VerificationConsumption): void;
  };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type VerifyEmailRequest = { token: string; idempotencyKey: string };

/**
 * 토큰으로 이메일을 인증한다 (ST-A01, 주체 SYS). 틀린 토큰·만료·재사용은 이유를 구별할 수 없게
 * 같은 FORBIDDEN으로 거부한다.
 */
export function verifyEmail(deps: VerifyEmailDeps, request: VerifyEmailRequest): Account {
  const now = (deps.now ?? (() => new Date()))();
  const tokenHash = hashVerificationToken(String(request.token));
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: "-",
      operation: "auth.verify-email",
      key: request.idempotencyKey,
      payload: { tokenHash },
    },
    () => {
      const verification = deps.emailVerifications.findByTokenHash(tokenHash);
      const account = verification && deps.accounts.get(verification.userId);
      if (
        !verification ||
        !account ||
        deps.verificationConsumptions.has(verification.id) ||
        Date.parse(verification.expiresAt) <= now.getTime()
      ) {
        throw new AppError("FORBIDDEN");
      }
      const verified: Account = { ...account, status: "VERIFIED", verifiedAt: now.toISOString() };
      deps.accounts.save(verified);
      deps.verificationConsumptions.save({
        verificationId: verification.id,
        userId: account.userId,
        consumedAt: now.toISOString(),
      });
      return verified;
    },
  );
}
