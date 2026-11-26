import { type DeactivateStoreRequest, type StoreStatus, type StoreStatusChange } from "../auth/deactivateStore";
import { reactivateStore, type ReactivateStoreRequest } from "../auth/reactivateStore";
import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { StoreSettings, StoreSettingsChange, UpdateStoreSettingsRequest } from "../auth/updateStoreSettings";
import { AppError } from "../errors/AppError";
import {
  inTransaction,
  isCommandKeyConflict,
  isUuid,
  loadCommands,
  loadMembership,
  principalFor,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";

type Actor = { userId: string };

/** 서점 기본정보(S-01): 활성 멤버가 읽는다. `longUnreceivedWarningDays`는 서점별 장기 미수령 경고일(S-07, 기본 7일) */
export type StoreInfo = { id: string; name: string; status: "ACTIVE"; createdAt: string; longUnreceivedWarningDays: number; customerRetentionDays?: number; myRole: "OWNER" | "STAFF" };
/** 설정 변경 요청 본문. 행위자(역할·이름)는 인증된 사용자에서 주입된다 */
/** 중지·해지 요청 본문. 행위자(역할·이름)는 인증된 사용자에서 주입된다 */
export type DeactivateStoreBody = Omit<DeactivateStoreRequest, "actorRole" | "changedBy">;
/** 운영자 승인 요청 본문. 승인한 운영자는 인증된 사용자에서 주입된다 */
export type ReactivateStoreBody = Omit<ReactivateStoreRequest, "adminUserId">;
/** 운영자 화면용: 중지·해지된 서점과 마지막 중지·해지 사유 */
export type InactiveStore = { storeId: string; name: string; status: Exclude<StoreStatus, "ACTIVE">; ownerUserId: string; reason?: string; deactivatedAt?: string; deactivatedBy?: string };
export type UpdateStoreSettingsBody = Omit<UpdateStoreSettingsRequest, "actorRole" | "changedBy">;

/**
 * 서점 기본정보 조회와 설정 변경(Owner만). 변경은 서점 행과 소유자의 서점들을 잠가 같은 소유자의 이름 중복 경쟁을 직렬화하고,
 * 바뀐 항목의 전·후 값을 추가 전용 이력에 남긴다.
 */
export function createPgStoreApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        throw error;
      }
    }
  };

  const updateOnce = (actor: Actor, request: UpdateStoreSettingsBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
      // 서점 행을 잠그고, 같은 소유자의 서점 개설·이름 변경과 같은 락으로 직렬화한다(openStore와 같은 키)
      const row = isUuid(request.tenantId) ? (await client.query("select * from public.ordering_tenants where id = $1 for update", [request.tenantId])).rows[0] : undefined;
      const toStore = (r: any): StoreSettings => ({ id: r.id, name: r.name, ownerUserId: r.owner_user_id, longUnreceivedWarningDays: r.long_unreceived_warning_days, ...(r.customer_retention_days === null ? {} : { customerRetentionDays: r.customer_retention_days }) });
      let owned: StoreSettings[] = [];
      if (row) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`open:${row.owner_user_id}`]);
        owned = (await client.query("select * from public.ordering_tenants where owner_user_id = $1", [row.owner_user_id])).rows.map(toStore);
      }
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const known = new Set(idempotency.keys());
      const applied: { change: StoreSettingsChange; next: StoreSettings }[] = [];
      const { tenantId: _t, ...rest } = request;
      void _t;
      const result = authorizedActions.updateStoreSettings(
        {
          stores: {
            get: (id) => owned.find((s) => s.id === id),
            listByOwner: (ownerUserId) => owned.filter((s) => s.ownerUserId === ownerUserId),
            apply: (change, next) => void applied.push({ change, next }),
          },
          idempotency,
        },
        principal,
        { ...rest, ...(request.name === undefined ? {} : { name: request.name }) },
      );
      for (const { change, next } of applied) {
        await client.query("update public.ordering_tenants set name = $2, long_unreceived_warning_days = $3, customer_retention_days = $4 where id = $1", [next.id, next.name, next.longUnreceivedWarningDays, next.customerRetentionDays ?? null]);
        await client.query("insert into public.ordering_tenant_setting_changes (id, tenant_id, changes, changed_by, changed_at) values ($1, $2, $3::jsonb, $4, $5)", [change.id, change.tenantId, JSON.stringify(change.changes), change.changedBy, change.changedAt]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  /** 서점 행을 잠그고 상태를 읽어 상태 변경 명령을 실행·저장한다(중지·재사용 공통). 서점 id가 uuid가 아니거나 없으면 NOT_FOUND */
  async function changeStatus(client: PoolClient, tenantId: string, idempotencyKey: unknown, run: (stores: { getStatus(id: string): StoreStatus | undefined; apply(change: StoreStatusChange, next: StoreStatus): void }, idempotency: Awaited<ReturnType<typeof loadCommands>>) => StoreStatusChange) {
    const row = isUuid(tenantId) ? (await client.query("select id, status from public.ordering_tenants where id = $1 for update", [tenantId])).rows[0] : undefined;
    const idempotency = await loadCommands(client, tenantId, idempotencyKey);
    const known = new Set(idempotency.keys());
    const applied: { change: StoreStatusChange; next: StoreStatus }[] = [];
    const result = run({ getStatus: (id) => (row && row.id === id ? (row.status as StoreStatus) : undefined), apply: (change, next) => void applied.push({ change, next }) }, idempotency);
    for (const { change, next } of applied) {
      await client.query("update public.ordering_tenants set status = $2 where id = $1", [change.tenantId, next]);
      await client.query('insert into public.ordering_tenant_status_changes (id, tenant_id, kind, from_status, to_status, reason, "by", "at") values ($1, $2, $3, $4, $5, $6, $7, $8)', [change.id, change.tenantId, change.kind, change.from, change.to, change.reason, change.by, change.at]);
    }
    await saveNewCommands(client, idempotency, known);
    return result;
  }

  return {
    /** Owner가 서점을 중지·해지한다. 그 순간부터 이 서점의 서점 범위 요청은 모두 FORBIDDEN이고 운영자 승인으로만 돌아온다 */
    deactivateStore: (actor: Actor, body: DeactivateStoreBody) =>
      withRetry(() =>
        inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
          const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
          const { tenantId: _t, ...rest } = body;
          void _t;
          return changeStatus(client, body.tenantId, body.idempotencyKey, (stores, idempotency) => authorizedActions.deactivateStore({ stores, idempotency }, principal, rest));
        }),
      ),

    /**
     * 플랫폼 운영자가 중지·해지된 서점의 재사용을 승인한다. **호출자가 운영자인지는 이 함수가 아니라 HTTP 경계가 확인한다**
     * (허용된 운영자 계정 목록). 서점 구성원 권한과 무관하다.
     */
    reactivateStore: (admin: Actor, body: ReactivateStoreBody) =>
      withRetry(() =>
        inTransaction(deps.pool, "service_role", admin.userId, (client) =>
          changeStatus(client, body.storeId, body.idempotencyKey, (stores, idempotency) => reactivateStore({ stores, idempotency }, { ...body, adminUserId: admin.userId })),
        ),
      ),

    /** 운영자 화면: 중지·해지된 서점(최근 중지·해지 순) */
    listInactiveStores: (admin: Actor): Promise<{ items: InactiveStore[] }> =>
      inTransaction(deps.pool, "service_role", admin.userId, async (client) => {
        const rows = (
          await client.query(
            `select t.id, t.name, t.status, t.owner_user_id, c.reason, c."at", c."by"
               from public.ordering_tenants t
               left join lateral (select x.reason, x."at", x."by" from public.ordering_tenant_status_changes x where x.tenant_id = t.id and x.kind = 'DEACTIVATED' order by x.recorded_at desc, x.id desc limit 1) c on true
              where t.status <> 'ACTIVE'
              order by c."at" desc nulls last, t.id`,
          )
        ).rows;
        return {
          items: rows.map((r): InactiveStore => ({ storeId: r.id, name: r.name, status: r.status, ownerUserId: r.owner_user_id, ...(r.reason === null ? {} : { reason: r.reason, deactivatedAt: (r.at as Date).toISOString(), deactivatedBy: r.by }) })),
        };
      }),

    /** 활성 멤버가 서점 기본정보와 자기 역할을 읽는다 */
    getStore: (actor: Actor, request: { tenantId: string }): Promise<StoreInfo> =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
        const r = (await client.query("select id, name, status, created_at, long_unreceived_warning_days, customer_retention_days from public.ordering_tenants where id = $1", [request.tenantId])).rows[0];
        if (!r) throw new AppError("NOT_FOUND");
        return { id: r.id, name: r.name, status: r.status, createdAt: (r.created_at as Date).toISOString(), longUnreceivedWarningDays: r.long_unreceived_warning_days, ...(r.customer_retention_days === null ? {} : { customerRetentionDays: r.customer_retention_days }), myRole: principal.role };
      }),

    /** Owner가 서점 이름·장기 미수령 경고일을 바꾼다. 요청의 담당자 필드는 무시되고 인증된 사용자로 기록된다 */
    updateStoreSettings: (actor: Actor, request: UpdateStoreSettingsBody) => withRetry(() => updateOnce(actor, request)),
  };
}
