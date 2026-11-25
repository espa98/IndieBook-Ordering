import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithAudit } from "../../src/db/auditContext";
import { inTransaction } from "../../src/db/pgSupport";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

const T = [1, 2, 3, 4].map((n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`);
const ACTOR = "11111111-0000-4000-8000-000000000001";
const HASH = "b".repeat(64);

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  for (const id of T) await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, $2, $3)`, [id, `서점 ${id.slice(-1)}`, ACTOR]);
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
const touch = (tenantId: string) => inTransaction(db.pool(), "service_role", ACTOR, (client) => client.query("insert into public.ordering_counters (tenant_id) values ($1)", [tenantId]));
const ctx = (over: Record<string, unknown> = {}) => ({ actorId: ACTOR, tenantId: T[0]!, operation: "POST /v1/tenants/{tenantId}/orders", commandKey: "key-1", requestHash: HASH, targets: { orderId: "o-1" }, ...over });

describe("감사 기록은 명령과 같은 트랜잭션이다 (inTransaction + 요청 맥락)", () => {
  it("요청 맥락이 있으면 성공한 쓰기 트랜잭션이 감사 행을 남기고, 맥락이 없으면(읽기·직접 호출) 남기지 않는다", async () => {
    await touch(T[1]!); // 맥락 없음
    expect(await rows("select 1 from public.ordering_audit_log")).toEqual([]);

    await runWithAudit(ctx(), () => touch(T[0]!));
    const log = await rows("select tenant_id, actor_id, operation, command_key, request_hash, targets from public.ordering_audit_log");
    expect(log).toEqual([{ tenant_id: T[0], actor_id: ACTOR, operation: "POST /v1/tenants/{tenantId}/orders", command_key: "key-1", request_hash: HASH, targets: { orderId: "o-1" } }]);
  });

  it("명령이 실패하면 감사 행도 남지 않고, 감사 행 저장이 실패하면 명령도 함께 롤백된다", async () => {
    const before = (await rows("select count(*)::int as n from public.ordering_audit_log"))[0].n as number;
    await expect(runWithAudit(ctx({ commandKey: "fail-1" }), () => inTransaction(db.pool(), "service_role", ACTOR, async (client) => {
      await client.query("insert into public.ordering_counters (tenant_id) values ($1)", [T[2]]);
      throw new Error("명령 실패");
    }))).rejects.toThrow("명령 실패");
    expect(await rows("select 1 from public.ordering_counters where tenant_id = $1", [T[2]])).toEqual([]);

    // 감사 행이 저장되지 않는 맥락(해시 형식 오류)이면 이미 실행한 명령도 커밋되지 않는다
    await expect(runWithAudit(ctx({ requestHash: "not-a-hash", commandKey: "fail-2" }), () => touch(T[3]!))).rejects.toThrow();
    expect(await rows("select 1 from public.ordering_counters where tenant_id = $1", [T[3]])).toEqual([]);
    expect((await rows("select count(*)::int as n from public.ordering_audit_log"))[0].n).toBe(before);
  });
});
