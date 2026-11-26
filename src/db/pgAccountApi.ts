import type { AccountPrincipal } from "../auth/accountPrincipal";
import type { Membership } from "../auth/authorizeTenantAccess";
import { openStore, type OpenStoreRequest, type Tenant } from "../auth/openStore";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import { deleteStaleCommands, inTransaction, isUuid, RESULT_SCHEMA_VERSION, type PoolLike } from "./pgSupport";

/** 서점 선택 목록의 한 줄: 내가 활성 멤버인 서점과 내 역할 */
export type MyMembership = { tenantId: string; tenantName: string; role: "OWNER" | "STAFF" };

/** 인증 제공자가 확인한 계정: 사용자 ID와 토큰의 이메일 claim */
type Account = { userId: string; email: string };

const OPEN_STORE = "auth.open-store";

/** 서점 개설의 멱등 기록 키. 개설 시점에는 서점이 없으므로 도메인은 서점 자리에 "-"를 쓰고, 저장은 새 서점의 행으로 한다 */
const storeKey = (commandKey: string) => JSON.stringify(["-", OPEN_STORE, commandKey]);

/** 서점에 속하기 전의 계정 업무를 Postgres 영속화 위에서 실행한다 (E7 권고안 a). */
export function createPgAccountApi(deps: { pool: PoolLike }) {
  /** 로그인한 계정이 서점을 연다(ST-A02). 서점과 Owner 멤버십은 한 트랜잭션에서 함께 저장된다 */
  const openStoreOnce = (account: Account, request: OpenStoreRequest) =>
    inTransaction(deps.pool, "service_role", account.userId, async (client) => {
      // 같은 계정의 서점 개설을 직렬화한다(같은 이름의 동시 개설 방지)
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`open:${account.userId}`]);
      const owned = (await client.query("select * from public.ordering_tenants where owner_user_id = $1", [account.userId])).rows.map(
        (t): Tenant => ({ id: t.id, name: t.name, status: t.status, ownerUserId: t.owner_user_id, createdAt: t.created_at.toISOString() }),
      );
      const savedTenants: Tenant[] = [];
      const savedMemberships: Membership[] = [];
      // 이전 개설 기록을 불러온다: 같은 계정의 같은 키 재시도는 같은 서점을 돌려준다
      const idempotency: IdempotencyStore = new Map();
      const commandKey = `${account.userId}:${request.idempotencyKey}`;
      if (typeof request.idempotencyKey === "string" && request.idempotencyKey.trim() !== "") {
        const prior = (await client.query("select payload_hash, result, result_version from public.ordering_commands where operation = $1 and command_key = $2", [OPEN_STORE, commandKey])).rows[0];
        if (prior && prior.result_version < RESULT_SCHEMA_VERSION) {
          // 옛 결과 형태의 기록은 삭제하고 없는 것으로 본다(호환 정책: 변환하지 않는다)
          await deleteStaleCommands(client, null, [{ operation: OPEN_STORE, command_key: commandKey }]);
        } else if (prior) idempotency.set(storeKey(commandKey), { payloadHash: prior.payload_hash, result: prior.result });
      }
      const known = new Set(idempotency.keys());
      const principal: AccountPrincipal = { kind: "ACCOUNT", userId: account.userId, email: account.email, verified: typeof account.email === "string" && account.email.trim() !== "" };
      const result = openStore(
        {
          tenants: { get: (id) => owned.find((t) => t.id === id), listByOwner: () => owned, save: (t) => void savedTenants.push(t) },
          memberships: { find: () => undefined, save: (m) => void savedMemberships.push(m) },
          idempotency,
        },
        principal,
        request,
      );
      for (const t of savedTenants) await client.query("insert into public.ordering_tenants (id, name, status, owner_user_id, created_at) values ($1, $2, $3, $4, $5)", [t.id, t.name, t.status, t.ownerUserId, t.createdAt]);
      for (const m of savedMemberships) await client.query("insert into public.ordering_members (tenant_id, user_id, role, active) values ($1, $2, $3, $4)", [m.tenantId, m.userId, m.role, m.status === "ACTIVE"]);
      for (const [entryKey, entry] of idempotency) {
        if (known.has(entryKey)) continue;
        const [, , key] = JSON.parse(entryKey) as [string, string, string];
        await client.query("insert into public.ordering_commands (tenant_id, operation, command_key, payload_hash, result, result_version) values ($1, $2, $3, $4, $5::jsonb, $6)", [result.tenant.id, OPEN_STORE, key, entry.payloadHash, JSON.stringify(entry.result), RESULT_SCHEMA_VERSION]);
      }
      return result;
    });

  /**
   * 서점 선택(A-05): 로그인한 계정이 **활성** 멤버로 속한 서점과 자기 역할. 비활성 멤버십은 나오지 않는다.
   * 대상은 요청이 아니라 인증된 사용자 본인뿐이다. 서점 이름 순(같으면 서점 ID).
   */
  const listMemberships = (actor: { userId: string }): Promise<MyMembership[]> => {
    if (!isUuid(actor.userId)) return Promise.resolve([]);
    return inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const rows = (
        await client.query(
          `select t.id as tenant_id, t.name as tenant_name, m.role
             from public.ordering_members m join public.ordering_tenants t on t.id = m.tenant_id
            where m.user_id = $1 and m.active
            order by t.name, t.id`,
          [actor.userId],
        )
      ).rows;
      return rows.map((r): MyMembership => ({ tenantId: r.tenant_id, tenantName: r.tenant_name, role: r.role }));
    });
  };

  return { openStore: openStoreOnce, listMemberships };
}
