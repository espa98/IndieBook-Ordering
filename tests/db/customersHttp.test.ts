import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** 고객 모듈 HTTP(C-01~04, 최소 수집 1차판): 등록·검색·상세·수정·이력·익명화를 실제 DB로 끝까지 확인한다 */
const SECRET = "customers-secret-0123456789abcdef0123";
const T = "aaaaaaaa-0000-4000-8000-0000000000c1";
const OWNER = "11111111-0000-4000-8000-0000000000c1";
const STAFF = "11111111-0000-4000-8000-0000000000c2";
const STRANGER = "99999999-0000-4000-8000-0000000000c1";
const PAST = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true)`, [T, OWNER, STAFF]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256" as const, key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
function call(method: "GET" | "POST", path: string, sub: string | undefined, opts: { query?: string; body?: unknown } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") headers["idempotency-key"] = `cu-${++seq}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(opts.query ?? ""), headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("고객 HTTP (C-01, C-02)", () => {
  it("직원이 등록(201)하고 목록에서 이름으로 찾으며(번호는 끝 4자리), 같은 번호의 재등록은 중복 후보를 돌려준다", async () => {
    const created = await call("POST", "/customers", STAFF, { body: { name: "김독자", phone: "010-1234-5678", registeredAt: PAST } });
    expect(created.status).toBe(201);
    expect(created.body.data.customer).toMatchObject({ name: "김독자", phone: "01012345678", version: 1 });
    expect(created.body.data.duplicateCandidates).toEqual([]);

    const again = await call("POST", "/customers", STAFF, { body: { name: "김독자", phone: "01012345678", registeredAt: PAST } });
    expect(again.body.data.duplicateCandidates).toEqual([{ customer: created.body.data.customer, sameName: true }]);

    const list = await call("GET", "/customers", STAFF, { query: "search=%EA%B9%80%EB%8F%85" });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.items[0]).toEqual({ id: again.body.data.customer.id, name: "김독자", phoneLast4: "5678", version: 1, anonymized: false });
    expect((await call("GET", "/customers", STRANGER)).status).toBe(403);
    expect((await call("POST", "/customers", STAFF, { body: { name: "x", phone: "abc", registeredAt: PAST } })).status).toBe(400);
  });
});

describe("고객 HTTP (C-03, C-04, 익명화)", () => {
  it("상세 조회 → 수정(200, 낡은 버전은 409) → 이력(Owner는 전·후, 직원은 사실만) → 직원 익명화 403 → Owner 익명화 200", async () => {
    const { body } = await call("POST", "/customers", STAFF, { body: { name: "흐름고객", phone: "010-9000-1111", registeredAt: PAST } });
    const id = body.data.customer.id as string;

    const detail = await call("GET", `/customers/${id}`, STAFF);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id, name: "흐름고객", phone: "01090001111", version: 1 });
    expect((await call("GET", "/customers/not-a-uuid", STAFF)).status).toBe(404);

    const updated = await call("POST", `/customers/${id}/updates`, STAFF, { body: { expectedVersion: 1, changes: { name: "변경고객" }, changedAt: PAST } });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ name: "변경고객", version: 2 });
    expect((await call("POST", `/customers/${id}/updates`, STAFF, { body: { expectedVersion: 1, changes: { name: "또" }, changedAt: PAST } })).status).toBe(409);

    const asOwner = await call("GET", `/customers/${id}/changes`, OWNER);
    expect(asOwner.body.data.items.map((i: { kind: string }) => i.kind)).toEqual(["REGISTERED", "UPDATED"]);
    expect(asOwner.body.data.items[1]).toMatchObject({ before: { name: "흐름고객" }, after: { name: "변경고객" } });
    const asStaff = await call("GET", `/customers/${id}/changes`, STAFF);
    expect(asStaff.body.data.items[1]).toEqual({ id: expect.any(String), kind: "UPDATED", by: STAFF, at: PAST });

    expect((await call("POST", `/customers/${id}/anonymization`, STAFF, { body: { expectedVersion: 2, anonymizedAt: PAST } })).status).toBe(403);
    const anon = await call("POST", `/customers/${id}/anonymization`, OWNER, { body: { expectedVersion: 2, anonymizedAt: PAST } });
    expect(anon.status).toBe(200);
    expect(anon.body.data).toEqual({ id, tenantId: T, name: "(익명)", phone: null, anonymizedAt: PAST, version: 3 });
    expect((await call("POST", `/customers/${id}/updates`, OWNER, { body: { expectedVersion: 3, changes: { name: "복구" }, changedAt: PAST } })).status).toBe(422);
  });
});
