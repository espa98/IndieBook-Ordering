import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStaffApi } from "../../src/db/pgStaffApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** S-02 직원 관리: 직원 목록과 초대 목록(Owner만). 초대 토큰·해시는 절대 나가지 않는다 */
const T = "aaaaaaaa-0000-4000-8000-0000000000c1";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000c2";
const OWNER = "11111111-0000-4000-8000-0000000000c1";
const STAFF = "11111111-0000-4000-8000-0000000000c2";
const EX_STAFF = "11111111-0000-4000-8000-0000000000c3";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000c4";
const STRANGER = "99999999-0000-4000-8000-0000000000c1";
const NOW = new Date("2026-03-10T00:00:00.000Z");

let db: IsolatedPostgres;
const hash = (n: number) => n.toString(16).padStart(64, "0");
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active, created_at) values
       ($1, $2, 'OWNER', true, '2026-03-01T00:00:00Z'), ($1, $3, 'STAFF', true, '2026-03-02T00:00:00Z'), ($1, $4, 'STAFF', false, '2026-03-03T00:00:00Z'), ($5, $6, 'OWNER', true, '2026-03-01T00:00:00Z')`,
    [T, OWNER, STAFF, EX_STAFF, OTHER_T, OTHER_OWNER],
  );
  // 초대 4건: 대기 중, 수락, 철회, 만료(+ 다른 서점의 초대 1건)
  const inv = async (n: number, tenant: string, email: string, invitedAt: string, expiresAt: string) => {
    const id = `cccccccc-0000-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
    await c.query(
      `insert into public.ordering_staff_invitations (id, tenant_id, email, role, token_hash, invited_by, invited_at, expires_at) values ($1, $2, $3, 'STAFF', $4, $5, $6, $7)`,
      [id, tenant, email, hash(n), OWNER, invitedAt, expiresAt],
    );
    return id;
  };
  await inv(1, T, "pending@shop.test", "2026-03-09T00:00:00Z", "2026-03-16T00:00:00Z");
  const accepted = await inv(2, T, "accepted@shop.test", "2026-03-02T00:00:00Z", "2026-03-09T00:00:00Z");
  const revoked = await inv(3, T, "revoked@shop.test", "2026-03-03T00:00:00Z", "2026-03-20T00:00:00Z");
  await inv(4, T, "expired@shop.test", "2026-03-01T00:00:00Z", "2026-03-08T00:00:00Z");
  await inv(5, OTHER_T, "theirs@shop.test", "2026-03-05T00:00:00Z", "2026-03-30T00:00:00Z");
  await c.query(`insert into public.ordering_invitation_events (tenant_id, invitation_id, kind, actor_id, at) values ($1, $2, 'ACCEPTED', $3, '2026-03-02T01:00:00Z'), ($1, $4, 'REVOKED', $5, '2026-03-04T00:00:00Z')`, [T, accepted, STAFF, revoked, OWNER]);
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const api = () => createPgStaffApi({ pool: db.pool(), now: () => NOW });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};

describe("직원 목록 (S-02)", () => {
  it("Owner는 서점의 모든 구성원(비활성 포함)을 역할(Owner 먼저)·합류 순으로 본다. 다른 서점 구성원은 나오지 않는다", async () => {
    expect(await api().listMembers({ userId: OWNER }, { tenantId: T })).toEqual([
      { userId: OWNER, role: "OWNER", status: "ACTIVE", joinedAt: "2026-03-01T00:00:00.000Z" },
      { userId: STAFF, role: "STAFF", status: "ACTIVE", joinedAt: "2026-03-02T00:00:00.000Z" },
      { userId: EX_STAFF, role: "STAFF", status: "INACTIVE", joinedAt: "2026-03-03T00:00:00.000Z" },
    ]);
  });

  it("직원·비활성 직원·비멤버는 FORBIDDEN이다(Owner만 권한을 관리한다)", async () => {
    for (const userId of [STAFF, EX_STAFF, STRANGER, OTHER_OWNER]) expect(await codeOf(() => api().listMembers({ userId }, { tenantId: T })), userId).toBe("FORBIDDEN");
  });
});

describe("초대 목록 (S-02)", () => {
  it("Owner는 서점의 초대를 최신 초대 순으로, 대기·수락·철회·만료 상태와 함께 본다. 토큰·해시는 없다", async () => {
    const list = await api().listInvitations({ userId: OWNER }, { tenantId: T });
    expect(list.map((i) => [i.email, i.status])).toEqual([
      ["pending@shop.test", "PENDING"],
      ["revoked@shop.test", "REVOKED"],
      ["accepted@shop.test", "ACCEPTED"],
      ["expired@shop.test", "EXPIRED"],
    ]);
    expect(list[0]).toEqual({
      id: "cccccccc-0000-4000-8000-000000000001", email: "pending@shop.test", role: "STAFF", invitedBy: OWNER,
      invitedAt: "2026-03-09T00:00:00.000Z", expiresAt: "2026-03-16T00:00:00.000Z", status: "PENDING",
    });
    expect(list[1]).toMatchObject({ status: "REVOKED", resolvedAt: "2026-03-04T00:00:00.000Z", resolvedBy: OWNER });
    expect(list[2]).toMatchObject({ status: "ACCEPTED", resolvedAt: "2026-03-02T01:00:00.000Z", resolvedBy: STAFF });
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/token|hash/i);
    expect(text).not.toContain("theirs@shop.test");
  });

  it("직원·비멤버는 FORBIDDEN이고, 시간이 지나면 대기 초대가 만료로 바뀐다", async () => {
    for (const userId of [STAFF, STRANGER]) expect(await codeOf(() => api().listInvitations({ userId }, { tenantId: T })), userId).toBe("FORBIDDEN");
    const later = createPgStaffApi({ pool: db.pool(), now: () => new Date("2026-03-17T00:00:00.000Z") });
    const list = await later.listInvitations({ userId: OWNER }, { tenantId: T });
    expect(list.find((i) => i.email === "pending@shop.test")?.status).toBe("EXPIRED");
    expect(list.find((i) => i.email === "revoked@shop.test")?.status).toBe("REVOKED");
  });
});
