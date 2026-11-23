import { AppError } from "../errors/AppError";

export type IdempotencyRequest = {
  tenantId: string;
  operation: string;
  key: string;
  payload: unknown;
};

type StoredEntry = { payloadHash: string; result: unknown };

export type IdempotencyStore = Map<string, StoredEntry>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function createIdempotencyStore(): IdempotencyStore {
  return new Map();
}

export function executeIdempotent<T>(
  store: IdempotencyStore,
  request: IdempotencyRequest,
  action: () => T,
): T {
  const storeKey = JSON.stringify([
    request.tenantId,
    request.operation,
    request.key,
  ]);
  const payloadHash = JSON.stringify(canonicalize(request.payload));
  const existing = store.get(storeKey);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new AppError("IDEMPOTENCY_CONFLICT");
    }
    return existing.result as T;
  }
  const result = action();
  store.set(storeKey, { payloadHash, result });
  return result;
}
