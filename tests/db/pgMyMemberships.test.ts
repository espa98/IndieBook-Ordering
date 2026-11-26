import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAccountApi } from "../../src/db/pgAccountApi";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** A-05 서점 선택: 로그인한 계정이 활성 멤버로 속한 서점과 자기 역할 목록 */
const ME = "66666666-0000-4000-8000-000000000001";
const OTHER = "66666666-0000-4000-8000-000000000002";
const T_OWN = "aaaaaaaa-0000-4000-8000-0000000000a1";
const T_STAFF = "aaaaaaaa-0000-4000-8000-0000000000a2";
const T_EX = "aaaaaaaa-0000-4000-8000-0000000000a3";
const T_NOT_MINE = "aaaaaaaa-0000-4000-8000-0000000000a4";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  const tenants: [string, string, string][] = [
    [T_OWN, "가나다 책방", ME],
    [T_STAFF, "나다라 서점", OTHER],
    [T_EX, "다라마 서점", OTHER],
    [T_NOT_MINE, "남의 서점", OTHER],
  ];
  for (const [id, name, owner] of tenants) await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, $2, $3)`, [id, name, owner]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values
       ($1, $5, 'OWNER', true), ($2, $5, 'STAFF', true), ($3, $5, 'STAFF', false),
       ($2, $6, 'OWNER', true), ($3, $6, 'OWNER', true), ($4, $6, 'OWNER', true)`,
    [T_OWN, T_STAFF, T_EX, T_NOT_MINE, ME, OTHER],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const api = () => createPgAccountApi({ pool: db.pool() });

describe("내 서점 목록 (A-05)", () => {
  it("활성 멤버로 속한 서점만 서점 이름 순으로 서점 ID·이름·내 역할과 함께 돌려준다 (비활성 멤버십·남의 서점은 제외)", async () => {
    expect(await api().listMemberships({ userId: ME })).toEqual([
      { tenantId: T_OWN, tenantName: "가나다 책방", role: "OWNER", storeStatus: "ACTIVE" },
      { tenantId: T_STAFF, tenantName: "나다라 서점", role: "STAFF", storeStatus: "ACTIVE" },
    ]);
  });

  it("다른 계정의 목록은 그 계정의 서점만이고, 서점이 없는 계정·UUID가 아닌 계정은 빈 목록이다", async () => {
    const other = await api().listMemberships({ userId: OTHER });
    expect(other.map((m) => m.tenantId).sort()).toEqual([T_EX, T_NOT_MINE, T_STAFF].sort());
    expect(other.find((m) => m.tenantId === T_STAFF)).toMatchObject({ role: "OWNER" });
    expect(await api().listMemberships({ userId: "66666666-0000-4000-8000-0000000000ff" })).toEqual([]);
    expect(await api().listMemberships({ userId: "not-a-uuid" })).toEqual([]);
  });

  it("멤버십이 비활성으로 바뀌면 다음 조회부터 목록에서 빠진다(캐시 없음)", async () => {
    const c = await db.connect();
    await c.query("update public.ordering_members set active = false where tenant_id = $1 and user_id = $2", [T_OWN, OTHER]).catch(() => undefined);
    await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'STAFF', true) on conflict do nothing`, [T_OWN, OTHER]);
    expect((await api().listMemberships({ userId: OTHER })).some((m) => m.tenantId === T_OWN)).toBe(true);
    await c.query("update public.ordering_members set active = false where tenant_id = $1 and user_id = $2", [T_OWN, OTHER]);
    await c.end();
    expect((await api().listMemberships({ userId: OTHER })).some((m) => m.tenantId === T_OWN)).toBe(false);
  });
});

describe("내 서점 목록의 서점 상태 (ST-A06/A07)", () => {
  it("중지·해지된 서점도 목록에 상태(storeStatus)와 함께 나와 프런트가 사용 불가 화면을 보여 줄 수 있고, 다시 승인되면 ACTIVE로 나온다", async () => {
    const c = await db.connect();
    await c.query(`update public.ordering_tenants set status = 'SUSPENDED' where id = $1`, [T_OWN]);
    await c.query(`update public.ordering_tenants set status = 'TERMINATED' where id = $1`, [T_STAFF]);
    await c.end();

    const list = await api().listMemberships({ userId: ME });
    expect(list.map((m: any) => [m.tenantId, m.storeStatus])).toEqual([[T_OWN, "SUSPENDED"], [T_STAFF, "TERMINATED"]]);

    const c2 = await db.connect();
    await c2.query(`update public.ordering_tenants set status = 'ACTIVE' where id in ($1, $2)`, [T_OWN, T_STAFF]);
    await c2.end();
    expect((await api().listMemberships({ userId: ME })).map((m: any) => m.storeStatus)).toEqual(["ACTIVE", "ACTIVE"]);
  });
});
