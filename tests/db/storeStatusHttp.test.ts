import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** 서점 중지·해지와 운영자 승인 재사용 HTTP: Owner가 중지하면 서점이 막히고, 허용된 운영자 계정의 승인으로만 돌아온다 */
const SECRET = "store-status-secret-0123456789abcdef012";
const T = "aaaaaaaa-0000-4000-8000-0000000000d9";
const OWNER = "11111111-0000-4000-8000-0000000000d9";
const STAFF = "11111111-0000-4000-8000-0000000000da";
const ADMIN = "11111111-0000-4000-8000-0000000000db";
const PAST = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
let appWithoutAdmins: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '중지 시험 서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T, OWNER, STAFF]);
  await c.end();
  const jwt = { keys: [{ kid: "k1", alg: "HS256" as const, key: SECRET }], audience: "authenticated" };
  app = createApp({ pool: db.pool(), jwt, platformAdminUserIds: [ADMIN] });
  appWithoutAdmins = createApp({ pool: db.pool(), jwt });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
function call(method: "GET" | "POST", path: string, sub: string, body?: unknown, target: ReturnType<typeof createApp> = app) {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { authorization: `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}` };
  if (method === "POST") headers["idempotency-key"] = `ss-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return target({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}
const tenant = (path: string) => `/v1/tenants/${T}${path}`;

describe("서점 중지·해지 HTTP (ST-A06, ST-A07)", () => {
  it("직원은 403, Owner가 중지(200)하면 서점의 모든 요청이 403이고 내 서점 목록에는 상태가 SUSPENDED로 나온다", async () => {
    expect((await call("GET", tenant("/store"), OWNER)).status).toBe(200);
    expect((await call("POST", tenant("/store/deactivation"), STAFF, { kind: "SUSPENDED", reason: "일시 중단", changedAt: PAST })).status).toBe(403);
    expect((await call("GET", tenant("/store"), OWNER)).status).toBe(200);

    const done = await call("POST", tenant("/store/deactivation"), OWNER, { kind: "SUSPENDED", reason: "일시 중단", changedAt: PAST });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ kind: "DEACTIVATED", from: "ACTIVE", to: "SUSPENDED", by: OWNER });

    for (const sub of [OWNER, STAFF]) {
      expect((await call("GET", tenant("/store"), sub)).status, sub).toBe(403);
      expect((await call("GET", tenant("/customers"), sub)).status, sub).toBe(403);
      expect((await call("GET", tenant("/dashboard"), sub)).status, sub).toBe(403);
    }
    const mine = await call("GET", "/v1/me/memberships", OWNER);
    expect(mine.body.data).toEqual([{ tenantId: T, tenantName: "중지 시험 서점", role: "OWNER", storeStatus: "SUSPENDED" }]);
  });
});

describe("운영자 승인 재사용 HTTP", () => {
  it("운영자가 아닌 계정(Owner 포함)과 운영자 목록이 없는 서버는 403이고, 허용된 운영자는 목록을 보고 승인(200)하면 서점이 다시 열린다", async () => {
    expect((await call("GET", "/v1/admin/stores", OWNER)).status).toBe(403);
    expect((await call("POST", `/v1/admin/stores/${T}/reactivation`, OWNER, { reason: "스스로 승인", approvedAt: PAST })).status).toBe(403);
    expect((await call("GET", "/v1/admin/stores", ADMIN, undefined, appWithoutAdmins)).status).toBe(403);
    expect((await call("POST", `/v1/admin/stores/${T}/reactivation`, ADMIN, { reason: "x", approvedAt: PAST }, appWithoutAdmins)).status).toBe(403);
    expect((await call("GET", tenant("/store"), OWNER)).status).toBe(403); // 아직 중지 상태

    const listed = await call("GET", "/v1/admin/stores", ADMIN);
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toEqual([expect.objectContaining({ storeId: T, status: "SUSPENDED", reason: "일시 중단", ownerUserId: OWNER })]);

    const approved = await call("POST", `/v1/admin/stores/${T}/reactivation`, ADMIN, { reason: "운영자 확인 완료", approvedAt: PAST });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ kind: "REACTIVATED", from: "SUSPENDED", to: "ACTIVE", by: ADMIN });
    expect((await call("GET", tenant("/store"), OWNER)).status).toBe(200);
    expect((await call("GET", tenant("/customers"), STAFF)).status).toBe(200);
    expect((await call("POST", `/v1/admin/stores/${T}/reactivation`, ADMIN, { reason: "또", approvedAt: PAST })).status).toBe(422);
    expect((await call("GET", "/v1/admin/stores", ADMIN)).body.data.items).toEqual([]);
  });
});
