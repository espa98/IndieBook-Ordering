import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { createPgStaffApi } from "../../src/db/pgStaffApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const OWNER_A2 = "11111111-0000-4000-8000-000000000010"; // 두 번째 Owner
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const STAFF_B = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'OWNER', true), ($1, $4, 'STAFF', true), ($1, $5, 'STAFF', true), ($6, $7, 'OWNER', true)`,
    [T_A, OWNER_A, OWNER_A2, STAFF_A, STAFF_B, T_B, OWNER_B],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const owner2 = { userId: OWNER_A2 };
const staff = { userId: STAFF_A };
let seq = 0;
const key = () => `st-${++seq}`;
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort();
const api = () => createPgStaffApi({ pool: db.pool() });
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const invite = (email: string, actor = owner, expiresAt = inDays(7), tenantId = T_A) => api().inviteStaff(actor, { tenantId, email, expiresAt, idempotencyKey: key() });
const revoke = (invitationId: string, actor = owner) => api().revokeInvitation(actor, { tenantId: T_A, invitationId, idempotencyKey: key() });
const setStatus = (targetUserId: string, status: "ACTIVE" | "INACTIVE", actor = owner) => api().setMembershipStatus(actor, { tenantId: T_A, targetUserId, status, idempotencyKey: key() });

describe("직원 초대·철회 (Postgres 영속화)", () => {
  it("Owner만 직원을 초대하고 토큰은 해시만 저장되며(멱등 기록에도 원문이 남지 않는다), 잘못된 이메일·만료·중복 초대는 거부된다", async () => {
    expect(await codeOf(() => invite("new@shop.test", staff))).toBe("FORBIDDEN");
    expect(await codeOf(() => invite("new@shop.test", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => invite("not-an-email"))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => invite("new@shop.test", owner, inDays(-1)))).toBe("VALIDATION_ERROR"); // 과거
    expect(await codeOf(() => invite("new@shop.test", owner, inDays(31)))).toBe("VALIDATION_ERROR"); // 30일 초과

    const { invitation, token } = await invite("  New@Shop.Test ");
    expect(invitation).toMatchObject({ tenantId: T_A, email: "new@shop.test", role: "STAFF", invitedBy: OWNER_A });
    expect(token.length).toBeGreaterThanOrEqual(32);
    const stored = (await rows("select email, token_hash from public.ordering_staff_invitations where id = $1", [invitation.id]))[0];
    expect(stored).toEqual({ email: "new@shop.test", token_hash: createHash("sha256").update(token).digest("hex") });
    // 토큰 원문은 어떤 테이블에도 남지 않는다
    expect(await rows("select 1 from public.ordering_commands where result::text like $1", [`%${token}%`])).toEqual([]);
    expect(await rows("select 1 from public.ordering_staff_invitations where token_hash = $1 or email = $1", [token])).toEqual([]);

    expect(await codeOf(() => invite("new@shop.test"))).toBe("BUSINESS_INVARIANT"); // 쓸 수 있는 초대가 이미 있다
    expect(await codeOf(() => invite("NEW@shop.test"))).toBe("BUSINESS_INVARIANT"); // 대소문자 무관
    expect((await invite("other@shop.test")).invitation.email).toBe("other@shop.test");
    expect((await invite("new@shop.test", owner, inDays(7), T_B).catch((e: AppError) => e.code))).toBe("FORBIDDEN"); // 다른 서점의 Owner가 아니다
  });

  it("같은 멱등 키로 다시 보내면 같은 초대를 돌려주되 토큰은 다시 주지 않고, 철회하면 같은 이메일을 다시 초대할 수 있다", async () => {
    const request = { tenantId: T_A, email: "retry@shop.test", expiresAt: inDays(7), idempotencyKey: key() };
    const first = await api().inviteStaff(owner, request);
    const replay = await createPgStaffApi({ pool: db.pool() }).inviteStaff(owner, request);

    expect(replay.invitation.id).toBe(first.invitation.id);
    expect(first.token).toBeTruthy();
    expect(replay.token).toBeFalsy(); // 원문 토큰은 처음 응답에만 있다
    expect((await rows("select count(*)::int as n from public.ordering_staff_invitations where email = 'retry@shop.test'"))[0].n).toBe(1);

    expect(await codeOf(() => revoke("0a000000-0000-4000-8000-00000000ffff"))).toBe("NOT_FOUND");
    expect(await codeOf(() => revoke(first.invitation.id, staff))).toBe("FORBIDDEN");
    const event = await revoke(first.invitation.id);
    expect(event).toMatchObject({ invitationId: first.invitation.id, kind: "REVOKED", actorId: OWNER_A });
    expect((await rows("select kind from public.ordering_invitation_events where invitation_id = $1", [first.invitation.id]))[0].kind).toBe("REVOKED");
    expect(await codeOf(() => revoke(first.invitation.id))).toBe("BUSINESS_INVARIANT"); // 이미 철회됨
    expect((await invite("retry@shop.test")).invitation.id).not.toBe(first.invitation.id); // 철회 뒤에는 다시 초대할 수 있다
  });

  it("같은 이메일을 두 세션이 동시에 초대하면 하나만 성공하고, 직접 SQL로도 중복 초대·두 번째 종결 사건을 넣을 수 없다", async () => {
    const results = await Promise.allSettled([invite("race@shop.test"), invite("race@shop.test")]);
    expect(outcomes(results)).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect((await rows("select count(*)::int as n from public.ordering_staff_invitations where email = 'race@shop.test'"))[0].n).toBe(1);

    const c = await db.connect();
    try {
      const ins = (email: string) => `insert into public.ordering_staff_invitations (tenant_id, email, token_hash, invited_by, invited_at, expires_at) values ('${T_A}', '${email}', '${createHash("sha256").update(email + Math.random()).digest("hex")}', 'raw', now(), now() + interval '7 days')`;
      expect(await sqlState(() => c.query(ins("race@shop.test")))).toBe("P0001"); // 쓸 수 있는 초대가 이미 있다
      const id = (await c.query(`select id from public.ordering_staff_invitations where email = 'race@shop.test'`)).rows[0].id as string;
      const ev = (kind: string) => `insert into public.ordering_invitation_events (tenant_id, invitation_id, kind, actor_id, at) values ('${T_A}', '${id}', '${kind}', 'raw', now())`;
      await c.query(ev("REVOKED"));
      expect(await sqlState(() => c.query(ev("ACCEPTED")))).toBe("23505"); // 초대당 종결 사건은 하나
      expect(await sqlState(() => c.query(`update public.ordering_invitation_events set kind = 'ACCEPTED' where invitation_id = '${id}'`))).toBe("P0001"); // 추가 전용
    } finally {
      await c.end();
    }
  });
});

describe("직원 비활성화·복구 (Postgres 영속화)", () => {
  it("Owner만 직원을 비활성화·복구하고 변경 이력이 남으며, 비활성 직원은 즉시 접근이 막히고, 같은 상태·없는 직원·비멤버는 거부된다", async () => {
    expect(await codeOf(() => setStatus(STAFF_B, "INACTIVE", staff))).toBe("FORBIDDEN");
    expect(await codeOf(() => setStatus(STAFF_B, "INACTIVE", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => setStatus(STRANGER, "INACTIVE"))).toBe("NOT_FOUND");
    expect(await codeOf(() => setStatus(STAFF_B, "ACTIVE"))).toBe("BUSINESS_INVARIANT"); // 이미 활성

    const change = await setStatus(STAFF_B, "INACTIVE");
    expect(change).toMatchObject({ userId: STAFF_B, from: "ACTIVE", to: "INACTIVE", changedBy: OWNER_A });
    expect((await rows("select active from public.ordering_members where tenant_id = $1 and user_id = $2", [T_A, STAFF_B]))[0].active).toBe(false);
    expect((await rows("select from_status, to_status, changed_by from public.ordering_membership_changes where user_id = $1", [STAFF_B]))[0]).toEqual({ from_status: "ACTIVE", to_status: "INACTIVE", changed_by: OWNER_A });

    // 비활성화는 다음 요청부터 즉시 서버 접근을 막는다
    const orders = createPgOrderApi({ pool: db.pool() });
    expect(await codeOf(() => orders.createOrder({ userId: STAFF_B }, { tenantId: T_A, idempotencyKey: key(), lines: [] }))).toBe("FORBIDDEN");
    expect(await codeOf(() => setStatus(STAFF_B, "INACTIVE"))).toBe("BUSINESS_INVARIANT");
    expect((await setStatus(STAFF_B, "ACTIVE")).to).toBe("ACTIVE");
  });

  it("마지막 활성 Owner는 비활성화할 수 없고, 두 Owner를 두 세션이 동시에 서로 내려도 한쪽만 성공한다", async () => {
    const results = await Promise.allSettled([setStatus(OWNER_A2, "INACTIVE", owner), setStatus(OWNER_A, "INACTIVE", owner2)]);
    // 한쪽이 먼저 성공하면 다른 쪽은 이미 비활성화된 Owner의 요청(FORBIDDEN)이거나 마지막 Owner 보호(BUSINESS_INVARIANT)로 거부된다
    const sorted = outcomes(results);
    expect(sorted).toContain("OK");
    expect(sorted.filter((o) => o === "OK")).toHaveLength(1);
    expect(["FORBIDDEN", "BUSINESS_INVARIANT"]).toContain(sorted.find((o) => o !== "OK"));
    expect((await rows("select count(*)::int as n from public.ordering_members where tenant_id = $1 and role = 'OWNER' and active", [T_A]))[0].n).toBe(1); // Owner는 항상 한 명 이상 남는다

    const lastOwner = (await rows("select user_id from public.ordering_members where tenant_id = $1 and role = 'OWNER' and active", [T_A]))[0].user_id as string;
    expect(await codeOf(() => setStatus(lastOwner, "INACTIVE", { userId: lastOwner }))).toBe("BUSINESS_INVARIANT");

    // 정리: 경쟁에서 누가 비활성화될지는 정해져 있지 않으므로, 뒤의 테스트가 `owner`(OWNER_A)를 쓸 수 있게 둘 다 활성으로 되돌린다
    const demoted = lastOwner === OWNER_A ? OWNER_A2 : OWNER_A;
    await setStatus(demoted, "ACTIVE", { userId: lastOwner });
    expect((await rows("select count(*)::int as n from public.ordering_members where tenant_id = $1 and role = 'OWNER' and active", [T_A]))[0].n).toBe(2);
  });
});

describe("초대 수락 (Postgres 영속화)", () => {
  const NEW_USER = "44444444-0000-4000-8000-000000000001";
  const accept = (token: string, actor: { userId: string; email: string } = { userId: NEW_USER, email: "joiner@shop.test" }) =>
    api().acceptInvitation(actor, { token, idempotencyKey: key() });

  it("토큰과 이메일이 맞는 계정만 활성 Staff가 되고, 틀린 토큰·다른 이메일·재사용·철회·만료는 이유를 알 수 없게 같은 FORBIDDEN이다", async () => {
    const { invitation, token } = await invite("joiner@shop.test");

    expect(await codeOf(() => accept("x".repeat(43)))).toBe("FORBIDDEN"); // 틀린 토큰
    expect(await codeOf(() => accept(token, { userId: NEW_USER, email: "other@shop.test" }))).toBe("FORBIDDEN"); // 다른 이메일
    expect(await rows("select 1 from public.ordering_members where user_id = $1", [NEW_USER])).toEqual([]); // 거부는 아무것도 남기지 않는다

    expect(await accept(token, { userId: NEW_USER, email: " Joiner@Shop.Test " })).toMatchObject({ userId: NEW_USER, tenantId: T_A, role: "STAFF", status: "ACTIVE" });
    expect((await rows("select role, active from public.ordering_members where tenant_id = $1 and user_id = $2", [T_A, NEW_USER]))[0]).toEqual({ role: "STAFF", active: true });
    expect((await rows("select kind, actor_id from public.ordering_invitation_events where invitation_id = $1", [invitation.id]))[0]).toEqual({ kind: "ACCEPTED", actor_id: NEW_USER });

    expect(await codeOf(() => accept(token, { userId: "44444444-0000-4000-8000-000000000002", email: "joiner@shop.test" }))).toBe("FORBIDDEN"); // 재사용

    const revoked = await invite("revoked@shop.test");
    await revoke(revoked.invitation.id);
    expect(await codeOf(() => accept(revoked.token, { userId: "44444444-0000-4000-8000-000000000003", email: "revoked@shop.test" }))).toBe("FORBIDDEN");

    const expiring = await invite("expired@shop.test", owner, new Date(Date.now() + 1500).toISOString());
    await new Promise((r) => setTimeout(r, 1700));
    expect(await codeOf(() => accept(expiring.token, { userId: "44444444-0000-4000-8000-000000000004", email: "expired@shop.test" }))).toBe("FORBIDDEN");
  });

  it("같은 토큰을 두 계정이 동시에 수락해도 하나만 멤버가 되고, 이미 수락한 계정의 재시도는 같은 멤버십을 돌려주며, 이미 멤버인 계정은 거부된다", async () => {
    const { invitation, token } = await invite("race@shop.test");
    const a = { userId: "44444444-0000-4000-8000-000000000011", email: "race@shop.test" };
    const b = { userId: "44444444-0000-4000-8000-000000000012", email: "race@shop.test" };
    const results = await Promise.allSettled([accept(token, a), accept(token, b)]);
    expect(outcomes(results)).toEqual(["FORBIDDEN", "OK"]);
    expect((await rows("select count(*)::int as n from public.ordering_invitation_events where invitation_id = $1", [invitation.id]))[0].n).toBe(1);
    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect((await rows("select count(*)::int as n from public.ordering_members where user_id = any($1::uuid[])", [[a.userId, b.userId]]))[0].n).toBe(1);

    expect(await accept(token, winner)).toMatchObject({ userId: winner.userId, tenantId: T_A, status: "ACTIVE" }); // 재시도

    const existing = await invite("staff-b@shop.test");
    expect(await codeOf(() => accept(existing.token, { userId: STAFF_B, email: "staff-b@shop.test" }))).toBe("BUSINESS_INVARIANT"); // 이미 멤버
  });
});
