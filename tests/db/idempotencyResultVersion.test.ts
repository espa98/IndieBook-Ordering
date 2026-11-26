import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAccountApi } from "../../src/db/pgAccountApi";
import { createPgOrderApi } from "../../src/db/pgOrderApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/**
 * 멱등 기록 호환 정책(결정): 저장된 결과의 JSON 형태가 바뀌면 **오래된 기록은 삭제한다**(옛 형태를 해석하는 변환 코드를 두지 않는다).
 * 기록마다 `result_version`을 저장하고, 현재 버전보다 낮은 기록은 읽을 때 삭제하고 없는 것으로 본다.
 * 결과: 그 키의 재시도는 새 요청으로 다시 실행된다(옛 형태로 깨지지 않는다).
 */
const T = "aaaaaaaa-0000-4000-8000-000000000008";
const OWNER = "11111111-0000-4000-8000-000000000008";
const BOOK = "b0000000-0000-4000-8000-000000000008";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await c.query(
    `insert into public.ordering_books (id, tenant_id, title, authors, isbn, list_price_krw, source, manual_reason, created_by, created_at) values ($1, $2, '책', '{}', null, 10000, 'MANUAL', '시험', 'seed', now())`,
    [BOOK, T],
  );
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const rows = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const lines = (quantity = 1) => [{ bookId: BOOK, quantity, unitPriceKrw: "10000" }];

describe("멱등 기록 결과 버전", () => {
  it("새 기록은 현재 버전(1)으로 저장되고, 같은 키·같은 본문은 같은 결과, 다른 본문은 충돌이다", async () => {
    const api = createPgOrderApi({ pool: db.pool() });
    const first = await api.createOrder({ userId: OWNER }, { tenantId: T, idempotencyKey: "v-current", lines: lines() });
    expect((await rows("select result_version from public.ordering_commands where command_key = 'v-current'"))[0].result_version).toBe(1);
    expect((await api.createOrder({ userId: OWNER }, { tenantId: T, idempotencyKey: "v-current", lines: lines() })).id).toBe(first.id);
    expect(await codeOf(() => api.createOrder({ userId: OWNER }, { tenantId: T, idempotencyKey: "v-current", lines: lines(2) }))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("옛 버전 기록(형태가 다른 결과)은 삭제되고 그 키의 요청은 새로 실행된다(다른 본문이어도 충돌하지 않는다)", async () => {
    const api = createPgOrderApi({ pool: db.pool() });
    const first = await api.createOrder({ userId: OWNER }, { tenantId: T, idempotencyKey: "v-old", lines: lines() });
    await rows("update public.ordering_commands set result_version = 0, result = '{\"legacyShape\": true}'::jsonb where command_key = 'v-old'");

    const again = await api.createOrder({ userId: OWNER }, { tenantId: T, idempotencyKey: "v-old", lines: lines(3) });
    expect(again.id).not.toBe(first.id); // 옛 기록은 없는 것으로 보고 새 주문을 만든다
    expect(again.lines[0]?.quantity).toBe(3);
    const stored = await rows("select result_version, result->>'id' as id from public.ordering_commands where command_key = 'v-old'");
    expect(stored).toEqual([{ result_version: 1, id: again.id }]); // 옛 기록은 삭제되고 새 기록만 남는다
    expect((await api.createOrder({ userId: OWNER }, { tenantId: T, idempotencyKey: "v-old", lines: lines(3) })).id).toBe(again.id);
  });

  it("서점 개설 기록도 같은 정책을 따른다", async () => {
    const accounts = createPgAccountApi({ pool: db.pool() });
    const user = { userId: "55555555-0000-4000-8000-000000000008", email: "v@shop.test" };
    const first = await accounts.openStore(user, { storeName: "버전 서점", idempotencyKey: "v-store" });
    expect((await rows("select result_version from public.ordering_commands where command_key like '%v-store'"))[0].result_version).toBe(1);
    await rows("update public.ordering_commands set result_version = 0, result = '{\"legacyShape\": true}'::jsonb where command_key like '%v-store'");
    // 옛 기록은 없는 것으로 본다: 같은 이름은 이미 있어 업무 규칙으로 거부된다(옛 형태 때문에 깨지거나 옛 결과를 돌려주지 않는다).
    // 이 요청은 롤백되므로 삭제도 함께 롤백된다(다음 읽기에서 다시 삭제된다)
    expect(await codeOf(() => accounts.openStore(user, { storeName: "버전 서점", idempotencyKey: "v-store" }))).toBe("BUSINESS_INVARIANT");
    // 같은 키에 다른 이름: 옛 기록이 있었다면 IDEMPOTENCY_CONFLICT였을 것이다. 새로 실행되어 기록이 현재 버전으로 교체된다
    const second = await accounts.openStore(user, { storeName: "버전 서점 둘", idempotencyKey: "v-store" });
    expect(second.tenant.id).not.toBe(first.tenant.id);
    expect(await rows("select result_version from public.ordering_commands where command_key like '%v-store'")).toEqual([{ result_version: 1 }]);
    expect(first.tenant.name).toBe("버전 서점");
  });
});
