import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReadApi } from "../../src/db/pgReadApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** O-08 안내 대기: 서점 전체 안내 대상 큐(재안내로 대체된 대상 제외), 파생 상태·필터·커서. 메시지 문구·결과 메모는 싣지 않는다 */
const T = "aaaaaaaa-0000-4000-8000-0000000000e5";
const OTHER_T = "aaaaaaaa-0000-4000-8000-0000000000e6";
const OWNER = "11111111-0000-4000-8000-0000000000e5";
const STAFF = "11111111-0000-4000-8000-0000000000e7";
const EX_STAFF = "11111111-0000-4000-8000-0000000000e8";
const OTHER_OWNER = "11111111-0000-4000-8000-0000000000e6";
const STRANGER = "99999999-0000-4000-8000-0000000000e5";
const day = (n: number) => `2026-03-0${n}T00:00:00.000Z`;

let db: IsolatedPostgres;
const q = async (sql: string, params: unknown[] = []) => {
  const c = await db.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const reads = () => createPgReadApi({ pool: db.pool() });
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "OK";
  } catch (error) {
    return error instanceof AppError ? error.code : `NON_APP_ERROR:${(error as Error).message}`;
  }
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await startMigratedPostgres();
  await q(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2), ($3, '남의 서점', $4)`, [T, OWNER, OTHER_T, OTHER_OWNER]);
  await q(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $5, 'STAFF', true), ($1, $6, 'STAFF', false), ($3, $4, 'OWNER', true)`, [T, OWNER, OTHER_T, OTHER_OWNER, STAFF, EX_STAFF]);
  const order = async (tenant: string, n: number) => (await q(`insert into public.ordering_orders (tenant_id, status, display_number, total_krw) values ($1, 'CONFIRMED', $2, 1000) returning id`, [tenant, n]))[0].id as string;
  const [A, B, C] = [await order(T, 1), await order(T, 2), await order(T, 3)] as [string, string, string];
  const target = async (key: string, orderId: string, createdAt: string, renoticeOf: string | null = null, tenant = T) => {
    ids[key] = (await q(`insert into public.ordering_notification_targets (tenant_id, order_id, mode, renotice_of_target_id, lines, secured_total, created_by, created_at) values ($1, $2, 'FULL', $3, '[]'::jsonb, 2, 'u', $4) returning id`, [tenant, orderId, renoticeOf, createdAt]))[0].id as string;
  };
  const attempt = async (key: string, at: string) =>
    (await q(`insert into public.ordering_notification_attempts (tenant_id, target_id, channel, message_snapshot, attempted_by, attempted_at) values ($1, $2, 'SMS', '비밀 안내 문구', 'u', $3) returning id`, [T, ids[key], at]))[0].id as string;
  const result = (key: string, attemptId: string, outcome: string, at: string) =>
    q(`insert into public.ordering_notification_results (tenant_id, target_id, attempt_id, outcome, note, recorded_by, result_at) values ($1, $2, $3, $4, '비밀 결과 메모', 'u', $5)`, [T, ids[key], attemptId, outcome, at]);

  await target("A1", A, day(1)); // 대기
  await target("B1", B, day(2));
  await attempt("B1", day(2)); // 시도만
  await target("C1", C, day(3));
  await result("C1", await attempt("C1", day(3)), "FAILED", day(3));
  await target("C2", C, day(4), ids.C1); // C1의 재안내(C1은 대체됨), 대기
  await target("A2", A, day(5));
  await result("A2", await attempt("A2", day(5)), "FAILED", day(5)); // 실패
  await target("B2", B, day(6));
  await result("B2", await attempt("B2", day(6)), "MANUAL_RECORDED", day(6)); // 완료
  // 다른 서점의 대상
  const other = await order(OTHER_T, 1);
  await target("OTHER", other, day(7), null, OTHER_T);
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("안내 대기 큐 (O-08)", () => {
  it("재안내로 대체된 대상을 뺀 서점의 모든 안내 대상을 최신순으로 파생 상태·주문 표시번호와 함께 보여 준다", async () => {
    const page = await reads().listNotificationQueue({ userId: STAFF }, { tenantId: T });
    expect(page.items.map((i) => [i.id, i.status])).toEqual([
      [ids.B2, "MANUAL_RECORDED"], [ids.A2, "FAILED"], [ids.C2, "PENDING"], [ids.B1, "ATTEMPTED"], [ids.A1, "PENDING"],
    ]);
    expect(page.items.some((i) => i.id === ids.C1 || i.id === ids.OTHER)).toBe(false);
    expect(page.items.find((i) => i.id === ids.A2)).toEqual({
      id: ids.A2, orderId: expect.any(String), orderDisplayNumber: 1, mode: "FULL", securedTotal: 2, status: "FAILED", createdAt: day(5),
      attemptedAt: day(5), channel: "SMS", resultAt: day(5), resultOutcome: "FAILED",
    });
    expect(page.items.find((i) => i.id === ids.C2)).toMatchObject({ renoticeOfTargetId: ids.C1, status: "PENDING", orderDisplayNumber: 3 });
    expect(page.items.find((i) => i.id === ids.C2)).not.toHaveProperty("attemptedAt");
    expect(JSON.stringify(page)).not.toMatch(/비밀/);
  });

  it("status 필터와 커서 페이지네이션이 동작한다(필터 뒤에도 커서가 이어진다)", async () => {
    const byStatus = async (status: string) => (await reads().listNotificationQueue(owner(), { tenantId: T, status: status as never })).items.map((i) => i.id);
    expect(await byStatus("PENDING")).toEqual([ids.C2, ids.A1]);
    expect(await byStatus("FAILED")).toEqual([ids.A2]);
    expect(await byStatus("ATTEMPTED")).toEqual([ids.B1]);
    expect(await byStatus("MANUAL_RECORDED")).toEqual([ids.B2]);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reads().listNotificationQueue(owner(), { tenantId: T, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([ids.B2, ids.A2, ids.C2, ids.B1, ids.A1]);
    const pending = await reads().listNotificationQueue(owner(), { tenantId: T, status: "PENDING", limit: 1 });
    expect((await reads().listNotificationQueue(owner(), { tenantId: T, status: "PENDING", limit: 1, cursor: pending.nextCursor })).items.map((i) => i.id)).toEqual([ids.A1]);
  });

  it("잘못된 limit·cursor·status는 VALIDATION_ERROR, 비멤버·비활성은 FORBIDDEN(검증보다 먼저), 다른 서점 대상은 그 서점에서만 보인다", async () => {
    for (const bad of [{ limit: 0 }, { limit: 101 }, { cursor: "%%%" }, { status: "DONE" as never }]) {
      expect(await codeOf(() => reads().listNotificationQueue(owner(), { tenantId: T, ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    for (const userId of [STRANGER, EX_STAFF, OTHER_OWNER]) expect(await codeOf(() => reads().listNotificationQueue({ userId }, { tenantId: T, limit: 0 })), userId).toBe("FORBIDDEN");
    expect((await reads().listNotificationQueue({ userId: OTHER_OWNER }, { tenantId: OTHER_T })).items.map((i) => i.id)).toEqual([ids.OTHER]);
  });
});

function owner() {
  return { userId: OWNER };
}
