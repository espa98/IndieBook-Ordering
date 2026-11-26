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
export type StoreInfo = { id: string; name: string; status: "ACTIVE"; createdAt: string; longUnreceivedWarningDays: number; myRole: "OWNER" | "STAFF" };
/** 설정 변경 요청 본문. 행위자(역할·이름)는 인증된 사용자에서 주입된다 */
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
      const toStore = (r: any): StoreSettings => ({ id: r.id, name: r.name, ownerUserId: r.owner_user_id, longUnreceivedWarningDays: r.long_unreceived_warning_days });
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
        await client.query("update public.ordering_tenants set name = $2, long_unreceived_warning_days = $3 where id = $1", [next.id, next.name, next.longUnreceivedWarningDays]);
        await client.query("insert into public.ordering_tenant_setting_changes (id, tenant_id, changes, changed_by, changed_at) values ($1, $2, $3::jsonb, $4, $5)", [change.id, change.tenantId, JSON.stringify(change.changes), change.changedBy, change.changedAt]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  return {
    /** 활성 멤버가 서점 기본정보와 자기 역할을 읽는다 */
    getStore: (actor: Actor, request: { tenantId: string }): Promise<StoreInfo> =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
        const r = (await client.query("select id, name, status, created_at, long_unreceived_warning_days from public.ordering_tenants where id = $1", [request.tenantId])).rows[0];
        if (!r) throw new AppError("NOT_FOUND");
        return { id: r.id, name: r.name, status: r.status, createdAt: (r.created_at as Date).toISOString(), longUnreceivedWarningDays: r.long_unreceived_warning_days, myRole: principal.role };
      }),

    /** Owner가 서점 이름·장기 미수령 경고일을 바꾼다. 요청의 담당자 필드는 무시되고 인증된 사용자로 기록된다 */
    updateStoreSettings: (actor: Actor, request: UpdateStoreSettingsBody) => withRetry(() => updateOnce(actor, request)),
  };
}
