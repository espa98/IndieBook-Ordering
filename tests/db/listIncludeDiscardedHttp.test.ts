import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { IsolatedPostgres } from "../helpers/isolatedPostgres";
import { signHs256 } from "../helpers/jwtSign";
import { startMigratedPostgres } from "../helpers/migratedPostgres";

/** GET /orders?includeDiscarded=: 폐기된 초안(ST-O09)은 기본 제외, true면 포함, 그 밖의 값은 400 */
const SECRET = "list-discarded-secret-0123456789abcdef01";
const T = "aaaaaaaa-0000-4000-8000-00000000000d";
const OWNER = "11111111-0000-4000-8000-00000000000d";
const PAST = "2026-03-04T06:00:00.000Z";

let db: IsolatedPostgres;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startMigratedPostgres();
  const c = await db.connect();
  await c.query(`insert into public.ordering_tenants (id, name, owner_user_id) values ($1, '서점', $2)`, [T, OWNER]);
  await c.query(`insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, 'OWNER', true)`, [T, OWNER]);
  await c.end();
  app = createApp({ pool: db.pool(), jwt: { keys: [{ kid: "k1", alg: "HS256", key: SECRET }], audience: "authenticated" } });
}, 180_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

let seq = 0;
async function call(method: "GET" | "POST", path: string, query = "", body?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: OWNER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now }, SECRET, { kid: "k1" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "POST") headers["idempotency-key"] = `lid-${++seq}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app({ method, path: `/v1/tenants/${T}${path}`, query: new URLSearchParams(query), headers, rawBody: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as any };
}

describe("GET /orders includeDiscarded", () => {
  it("폐기된 초안은 기본 제외, includeDiscarded=true면 포함(discardedAt 표시), false는 기본과 같고, 다른 값은 400", async () => {
    const keep = (await call("POST", "/orders", "", { lines: [] })).body.data;
    const gone = (await call("POST", "/orders", "", { lines: [] })).body.data;
    expect((await call("POST", `/orders/${gone.id}/discard`, "", { expectedVersion: 1, reason: "철회", discardedAt: PAST })).status).toBe(200);

    const ids = async (query: string) => (await call("GET", "/orders", query)).body.data.items.map((i: { id: string }) => i.id) as string[];
    expect(await ids("")).toEqual([keep.id]);
    expect(await ids("includeDiscarded=false")).toEqual([keep.id]);
    const all = (await call("GET", "/orders", "includeDiscarded=true")).body.data.items as { id: string; discardedAt?: string }[];
    expect(all.map((i) => i.id).sort()).toEqual([keep.id, gone.id].sort());
    expect(all.find((i) => i.id === gone.id)?.discardedAt).toBe(PAST);

    for (const bad of ["yes", "1", "TRUE", ""]) {
      const res = await call("GET", "/orders", `includeDiscarded=${bad}`);
      expect(res.status, `includeDiscarded=${bad}`).toBe(400);
    }
  });
});
