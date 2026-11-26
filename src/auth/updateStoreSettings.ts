import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString } from "../procurement/validation";

const MAX_STORE_NAME_LENGTH = 60;
/** 장기 미수령 경고일의 허용 범위(일). 기본은 7일(DEC-07) */
export const MIN_WARNING_DAYS = 1;
export const MAX_WARNING_DAYS = 365;
export const DEFAULT_WARNING_DAYS = 7;

/** 서점 기본정보와 설정(S-01, S-07) */
export type StoreSettings = {
  id: string;
  name: string;
  ownerUserId: string;
  longUnreceivedWarningDays: number;
};

/** 설정 변경 기록(추가 전용): 바뀐 항목의 전·후 값 */
export type StoreSettingsChange = {
  id: string;
  tenantId: string;
  changes: {
    name?: { from: string; to: string };
    longUnreceivedWarningDays?: { from: number; to: number };
  };
  changedBy: string;
  changedAt: string;
};

export type UpdateStoreSettingsDeps = {
  stores: {
    get(tenantId: string): StoreSettings | undefined;
    listByOwner(ownerUserId: string): StoreSettings[];
    /** 변경 기록을 남기고 서점 설정을 새 값으로 바꾼다 */
    apply(change: StoreSettingsChange, next: StoreSettings): void;
  };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type UpdateStoreSettingsRequest = {
  tenantId: string;
  name?: string;
  longUnreceivedWarningDays?: number;
  actorRole: "OWNER" | "STAFF";
  changedBy: string;
  idempotencyKey: string;
};

/**
 * Owner가 서점 이름과 장기 미수령 경고일을 바꾼다(보낸 항목만). 같은 소유자의 다른 서점 이름과 겹치면(대소문자 무시) 거부하고,
 * 바뀌는 항목이 없으면 거부한다. 바뀐 항목의 전·후 값이 기록된다.
 */
export function updateStoreSettings(deps: UpdateStoreSettingsDeps, request: UpdateStoreSettingsRequest): StoreSettingsChange {
  if (request.actorRole !== "OWNER") throw new AppError("FORBIDDEN");
  if (request.name === undefined && request.longUnreceivedWarningDays === undefined) invalid("settings", "must contain name or longUnreceivedWarningDays");
  if (request.name !== undefined && (!isNonEmptyString(request.name) || request.name.trim().length > MAX_STORE_NAME_LENGTH)) {
    invalid("name", `must be a non-empty string up to ${MAX_STORE_NAME_LENGTH} characters`);
  }
  const days = request.longUnreceivedWarningDays;
  if (days !== undefined && (!Number.isInteger(days) || days < MIN_WARNING_DAYS || days > MAX_WARNING_DAYS)) {
    invalid("longUnreceivedWarningDays", `must be an integer ${MIN_WARNING_DAYS}..${MAX_WARNING_DAYS}`);
  }
  if (!isNonEmptyString(request.changedBy)) invalid("changedBy", "must be a non-empty string");
  const name = request.name?.trim();
  const now = (deps.now ?? (() => new Date()))();
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "auth.update-store-settings",
      key: request.idempotencyKey,
      payload: { name: name ?? null, longUnreceivedWarningDays: days ?? null },
    },
    () => {
      const store = deps.stores.get(request.tenantId);
      if (!store) throw new AppError("NOT_FOUND");
      const changes: StoreSettingsChange["changes"] = {};
      if (name !== undefined && name !== store.name) {
        if (deps.stores.listByOwner(store.ownerUserId).some((s) => s.id !== store.id && s.name.toLowerCase() === name.toLowerCase())) {
          throw new AppError("BUSINESS_INVARIANT", "the owner already has a store with this name");
        }
        changes.name = { from: store.name, to: name };
      }
      if (days !== undefined && days !== store.longUnreceivedWarningDays) {
        changes.longUnreceivedWarningDays = { from: store.longUnreceivedWarningDays, to: days };
      }
      if (Object.keys(changes).length === 0) throw new AppError("BUSINESS_INVARIANT", "nothing to change");
      const change: StoreSettingsChange = { id: crypto.randomUUID(), tenantId: store.id, changes, changedBy: request.changedBy, changedAt: now.toISOString() };
      deps.stores.apply(change, { ...store, name: changes.name?.to ?? store.name, longUnreceivedWarningDays: changes.longUnreceivedWarningDays?.to ?? store.longUnreceivedWarningDays });
      return change;
    },
  );
}
