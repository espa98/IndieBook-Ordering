import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCatalogApi } from "../../src/db/pgCatalogApi";
import { AppError } from "../../src/errors/AppError";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { sqlState, startMigratedPostgres } from "../helpers/migratedPostgres";

const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const STAFF_A = "11111111-0000-4000-8000-000000000002";
const DELEGATE_A = "11111111-0000-4000-8000-000000000003";
const OWNER_B = "22222222-0000-4000-8000-000000000001";
const STRANGER = "33333333-0000-4000-8000-000000000001";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점 A', $2), ($3, '서점 B', $4)`, [T_A, OWNER_A, T_B, OWNER_B]);
  await c.query(
    `insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', true), ($5, $6, 'OWNER', true)`,
    [T_A, OWNER_A, STAFF_A, DELEGATE_A, T_B, OWNER_B],
  );
  await c.query(`insert into public.ordering_management_delegations (tenant_id, user_id, delegated_by, delegated_at) values ($1, $2, $3, now())`, [T_A, DELEGATE_A, OWNER_A]);
  await c.end();
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

const owner = { userId: OWNER_A };
const staff = { userId: STAFF_A };
const delegate = { userId: DELEGATE_A };
let seq = 0;
const key = () => `tpl-${++seq}`;
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
const api = () => createPgCatalogApi({ pool: db.pool() });
const publish = (templateKey: string, expectedVersion: number, body: string, actor = owner, tenantId = T_A) =>
  api().publishTemplateVersion(actor, { tenantId, key: templateKey, body, expectedVersion, publishedAt: new Date().toISOString(), idempotencyKey: key() });

describe("안내 문구 템플릿 게시 (Postgres 영속화)", () => {
  it("Owner·위임 직원만 게시하고 버전이 순서대로 오르며, 변수·본문 검증과 버전 충돌이 적용된다", async () => {
    expect(await codeOf(() => publish("SHORTAGE", 0, "{{bookTitle}} 입고 지연", staff))).toBe("FORBIDDEN"); // 위임 없는 직원
    expect(await codeOf(() => publish("SHORTAGE", 0, "{{bookTitle}} 입고 지연", { userId: STRANGER }))).toBe("FORBIDDEN");
    expect(await codeOf(() => publish("bad key", 0, "본문"))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => publish("SHORTAGE", 0, "{{customerPhone}}"))).toBe("VALIDATION_ERROR"); // 허용되지 않은 변수

    const v1 = await publish("SHORTAGE", 0, "{{bookTitle}} 입고가 늦어집니다.", delegate);
    expect(v1).toMatchObject({ tenantId: T_A, key: "SHORTAGE", version: 1, variables: ["bookTitle"], publishedBy: DELEGATE_A });
    expect(await codeOf(() => publish("SHORTAGE", 0, "다시"))).toBe("VERSION_CONFLICT");
    const v2 = await publish("SHORTAGE", 1, "{{bookTitle}} {{expectedArrival}} 입고 예정", owner);
    expect(v2.version).toBe(2);
    expect((await publish("OTHER", 0, "다른 키")).version).toBe(1);

    const stored = await rows("select version::int as v, body, variables from public.ordering_template_versions where tenant_id = $1 and key = 'SHORTAGE' order by version", [T_A]);
    expect(stored.map((r) => r.v)).toEqual([1, 2]);
    expect(stored[0].body).toBe("{{bookTitle}} 입고가 늦어집니다."); // 이전 버전은 바뀌지 않는다
    expect(stored[1].variables).toEqual(["bookTitle", "expectedArrival"]);
  });

  it("같은 버전을 여러 세션이 동시에 게시하면 하나만 성공하고, 직접 SQL로도 버전을 건너뛰거나 수정·삭제할 수 없다", async () => {
    const shared = api();
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => shared.publishTemplateVersion(owner, { tenantId: T_A, key: "RACE", body: `본문 ${i}`, expectedVersion: 0, publishedAt: new Date().toISOString(), idempotencyKey: key() })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "VERSION_CONFLICT")).toBe(true);
    expect((await rows("select count(*)::int as n from public.ordering_template_versions where key = 'RACE'"))[0].n).toBe(1);

    const c = await db.connect();
    try {
      const ins = (version: number) => `insert into public.ordering_template_versions (tenant_id, key, version, body, variables, published_by, published_at) values ('${T_A}', 'RACE', ${version}, '본문', '{}', 'raw', now())`;
      expect(await sqlState(() => c.query(ins(1)))).toBe("23505"); // 같은 버전
      expect(await sqlState(() => c.query(ins(3)))).toBe("P0001"); // 건너뜀
      expect(await sqlState(() => c.query(`update public.ordering_template_versions set body = 'x' where key = 'RACE'`))).toBe("P0001"); // 추가 전용
      expect(await sqlState(() => c.query(`delete from public.ordering_template_versions where key = 'RACE'`))).toBe("P0001");
    } finally {
      await c.end();
    }
  });
});
