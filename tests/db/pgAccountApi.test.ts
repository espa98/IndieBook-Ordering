import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAccountApi } from "../../src/db/pgAccountApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const USER_1 = "55555555-0000-4000-8000-000000000001";
const USER_2 = "55555555-0000-4000-8000-000000000002";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
const key = () => `acct-${++seq}`;
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
const api = () => createPgAccountApi({ pool: db.pool() });
const user1 = { userId: USER_1, email: "owner1@shop.test" };
const user2 = { userId: USER_2, email: "owner2@shop.test" };

describe("서점 개설 (Postgres 영속화)", () => {
  it("로그인한 계정이 서점을 열면 서점과 활성 Owner 멤버십이 함께 저장되고, 같은 이름의 중복·잘못된 이름·이메일 없는 계정은 거부된다", async () => {
    const { tenant, membership } = await api().openStore(user1, { storeName: "  책방, 오후 세시 ", idempotencyKey: key() });
    expect(tenant).toMatchObject({ name: "책방, 오후 세시", status: "ACTIVE", ownerUserId: USER_1 });
    expect(membership).toMatchObject({ userId: USER_1, tenantId: tenant.id, role: "OWNER", status: "ACTIVE" });
    expect((await rows("select name, owner_user_id from public.ordering_tenants where id = $1", [tenant.id]))[0]).toEqual({ name: "책방, 오후 세시", owner_user_id: USER_1 });
    expect((await rows("select role, active from public.ordering_members where tenant_id = $1 and user_id = $2", [tenant.id, USER_1]))[0]).toEqual({ role: "OWNER", active: true });

    expect(await codeOf(() => api().openStore(user1, { storeName: "책방, 오후 세시", idempotencyKey: key() }))).toBe("BUSINESS_INVARIANT"); // 같은 소유자의 같은 이름
    expect(await codeOf(() => api().openStore(user1, { storeName: "   ", idempotencyKey: key() }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api().openStore(user1, { storeName: "가".repeat(61), idempotencyKey: key() }))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => api().openStore({ userId: USER_1, email: "" }, { storeName: "이메일 없음", idempotencyKey: key() }))).toBe("FORBIDDEN");
    expect((await rows("select count(*)::int as n from public.ordering_tenants where owner_user_id = $1", [USER_1]))[0].n).toBe(1); // 거부된 시도는 아무것도 남기지 않는다

    expect((await api().openStore(user2, { storeName: "책방, 오후 세시", idempotencyKey: key() })).tenant.ownerUserId).toBe(USER_2); // 다른 소유자는 같은 이름 가능
  });

  it("같은 멱등 키의 재시도는 같은 서점을 돌려주고(다른 이름이면 충돌), 같은 이름·같은 키의 동시 개설도 서점은 하나만 만들어진다", async () => {
    const user = { userId: "55555555-0000-4000-8000-000000000003", email: "owner3@shop.test" };
    const k = key();
    const first = await api().openStore(user, { storeName: "재시도 서점", idempotencyKey: k });
    const retry = await api().openStore(user, { storeName: "재시도 서점", idempotencyKey: k });
    expect(retry).toEqual(first);
    expect(await codeOf(() => api().openStore(user, { storeName: "다른 이름", idempotencyKey: k }))).toBe("IDEMPOTENCY_CONFLICT");
    expect((await rows("select count(*)::int as n from public.ordering_tenants where owner_user_id = $1", [user.userId]))[0].n).toBe(1);

    const racer = { userId: "55555555-0000-4000-8000-000000000004", email: "owner4@shop.test" };
    const sameKey = key();
    const same = await Promise.all([api().openStore(racer, { storeName: "동시 서점", idempotencyKey: sameKey }), api().openStore(racer, { storeName: "동시 서점", idempotencyKey: sameKey })]);
    expect(same[0]).toEqual(same[1]);
    const results = await Promise.allSettled([api().openStore(racer, { storeName: "경쟁 서점", idempotencyKey: key() }), api().openStore(racer, { storeName: "경쟁 서점", idempotencyKey: key() })]);
    expect(results.map((r) => (r.status === "fulfilled" ? "OK" : (r.reason as AppError).code)).sort()).toEqual(["BUSINESS_INVARIANT", "OK"]);
    expect((await rows("select count(*)::int as n from public.ordering_tenants where owner_user_id = $1", [racer.userId]))[0].n).toBe(2);
  });
});
