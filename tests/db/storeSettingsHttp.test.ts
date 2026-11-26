import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /store, POST /store/settings (S-01 서점 기본정보, S-07 미수령 경고일): 조회는 활성 멤버, 변경은 Owner만 */
const SECRET = "store-settings-secret-0123456789abcdef";
const T = "aaaaaaaa-0000-4000-8000-0000000000f3";
const OWNER = "11111111-0000-4000-8000-0000000000f3";
const STAFF = "11111111-0000-4000-8000-0000000000f4";
const EX_STAFF = "11111111-0000-4000-8000-0000000000f5";
const STRANGER = "99999999-0000-4000-8000-0000000000f3";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '책방 오후 세시', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true), ($1, $3, 'STAFF', true), ($1, $4, 'STAFF', false)`, [T, OWNER, STAFF, EX_STAFF]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
function call(method: "GET" | "POST", path: string, sub: string | undefined, body?: unknown, query = "") {
  const now = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (sub) headers.authorization = `Bearer ${signHs256({ sub, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" })}`;
  if (method === "POST") headers["idempotency-key"] = `st-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(query), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body)) as any }));
}

describe("서점 기본정보·설정 HTTP", () => {
  it("직원도 서점 정보를 읽고, Owner가 이름·경고일을 바꾸면 조회에 반영되며 변경 기록(전·후 값)이 돌아온다", async () => {
    const info = await call("GET", "/store", STAFF);
    expect(info.status).toBe(200);
    expect(info.body.data).toEqual({ id: T, name: "책방 오후 세시", status: "ACTIVE", createdAt: expect.any(String), longUnreceivedWarningDays: 7, myRole: "STAFF" });

    const changed = await call("POST", "/store/settings", OWNER, { name: "책방, 오후 네시", longUnreceivedWarningDays: 10 });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ tenantId: T, changedBy: OWNER, changes: { name: { from: "책방 오후 세시", to: "책방, 오후 네시" }, longUnreceivedWarningDays: { from: 7, to: 10 } } });
    expect((await call("GET", "/store", OWNER)).body.data).toMatchObject({ name: "책방, 오후 네시", longUnreceivedWarningDays: 10, myRole: "OWNER" });
  });

  it("직원·비멤버는 변경 403, 조회는 비멤버·비활성 403, 인증 없음 401, 알 수 없는 필드(행위자 포함)·범위 밖 값은 400, 같은 값은 422, POST /store·GET /store/settings는 405", async () => {
    const body = { name: "다른 이름" };
    expect((await call("POST", "/store/settings", STAFF, body)).status).toBe(403);
    expect((await call("POST", "/store/settings", STRANGER, body)).status).toBe(403);
    expect((await call("POST", "/store/settings", undefined, body)).status).toBe(401);
    for (const sub of [STRANGER, EX_STAFF]) expect((await call("GET", "/store", sub)).status, sub).toBe(403);
    expect((await call("GET", "/store", undefined)).status).toBe(401);
    for (const bad of [{}, { name: "x", actorRole: "OWNER" }, { name: "x", changedBy: "y" }, { longUnreceivedWarningDays: 0 }, { longUnreceivedWarningDays: 366 }, { longUnreceivedWarningDays: "7" }, { name: "" }]) {
      expect((await call("POST", "/store/settings", OWNER, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call("POST", "/store/settings", OWNER, { longUnreceivedWarningDays: 10 })).status).toBe(422); // 이미 10일
    expect((await call("GET", "/store", OWNER, undefined, "x=1")).status).toBe(400);
    expect((await call("POST", "/store", OWNER, {})).status).toBe(405);
    expect((await call("GET", "/store/settings", OWNER)).status).toBe(405);
  });

  it("경고일 설정은 장기 미수령 경고의 기본 기준일이 된다(대시보드·경고 목록이 같은 설정을 읽는다)", async () => {
    expect((await call("GET", "/long-unreceived-warnings", OWNER)).status).toBe(200);
    expect((await call("GET", "/dashboard", OWNER)).body.data.longUnreceivedWarnings).toBe(0);
    expect((await call("GET", "/long-unreceived-warnings", OWNER, undefined, "thresholdDays=0")).status).toBe(400); // 명시한 값도 여전히 검증한다
  });
});
