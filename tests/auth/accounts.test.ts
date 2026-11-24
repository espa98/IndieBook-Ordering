import { describe, it, expect } from "vitest";
import { registerAccount, verifyEmail } from "../../src/auth/accounts";
import { AppError } from "../../src/errors/AppError";
import { accountScene } from "../helpers/accountFixtures";

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
};

describe("registerAccount / verifyEmail: 이메일 인증 (ST-A01, AUTH-001)", () => {
  it("계정은 UNVERIFIED로 등록되고 토큰은 한 번만 돌려주며 해시만 저장하고, 토큰으로 인증하면 VERIFIED가 된다", () => {
    const { deps, accounts, verifications } = accountScene();

    const { account, token } = registerAccount(deps, { userId: "u-1", email: " Owner@Example.com ", idempotencyKey: "reg-1" });

    expect(account).toEqual({
      userId: "u-1",
      email: "owner@example.com",
      status: "UNVERIFIED",
      createdAt: "2026-03-04T07:00:00.000Z",
    });
    expect(token).toBe("verify-token-1");
    expect(JSON.stringify(verifications)).not.toContain("verify-token-1");
    expect(accounts[0]!.status).toBe("UNVERIFIED");

    const verified = verifyEmail(deps, { token, idempotencyKey: "ver-1" });

    expect(verified).toEqual({ ...account, status: "VERIFIED", verifiedAt: "2026-03-04T07:00:00.000Z" });
    expect(deps.accounts.get("u-1")).toEqual(verified);
  });

  it("틀린 토큰·만료·재사용은 이유를 구별할 수 없는 같은 FORBIDDEN 403이고 계정은 바뀌지 않는다", () => {
    const { deps, advance } = accountScene();
    const { token } = registerAccount(deps, { userId: "u-1", email: "a@example.com", idempotencyKey: "reg-1" });
    const second = registerAccount(deps, { userId: "u-2", email: "b@example.com", idempotencyKey: "reg-2" });

    expect(codeOf(() => verifyEmail(deps, { token: "wrong", idempotencyKey: "v-1" }))).toBe("FORBIDDEN");
    expect(deps.accounts.get("u-1")!.status).toBe("UNVERIFIED");

    verifyEmail(deps, { token, idempotencyKey: "v-2" });
    expect(codeOf(() => verifyEmail(deps, { token, idempotencyKey: "v-3" }))).toBe("FORBIDDEN"); // 재사용

    advance(25 * 3_600_000); // 24시간 뒤
    expect(codeOf(() => verifyEmail(deps, { token: second.token, idempotencyKey: "v-4" }))).toBe("FORBIDDEN"); // 만료
    expect(deps.accounts.get("u-2")!.status).toBe("UNVERIFIED");
  });

  it("이메일 형식 오류·빈 사용자 ID는 VALIDATION_ERROR 400이고, 같은 이메일·같은 사용자 ID의 재가입은 BUSINESS_INVARIANT 422이다", () => {
    const { deps, accounts } = accountScene();

    expect(codeOf(() => registerAccount(deps, { userId: "u-1", email: "nope", idempotencyKey: "r-1" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => registerAccount(deps, { userId: " ", email: "a@example.com", idempotencyKey: "r-2" }))).toBe("VALIDATION_ERROR");
    expect(accounts).toEqual([]);

    registerAccount(deps, { userId: "u-1", email: "a@example.com", idempotencyKey: "r-3" });
    expect(codeOf(() => registerAccount(deps, { userId: "u-2", email: "A@example.com", idempotencyKey: "r-4" }))).toBe("BUSINESS_INVARIANT");
    expect(codeOf(() => registerAccount(deps, { userId: "u-1", email: "other@example.com", idempotencyKey: "r-5" }))).toBe("BUSINESS_INVARIANT");
    expect(accounts).toHaveLength(1);
  });
});
