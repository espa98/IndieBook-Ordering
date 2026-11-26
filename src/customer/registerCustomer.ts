import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { normalizePhone } from "./normalizePhone";

/** 고객(1차 최소 수집: 이름 또는 별칭 + 전화번호만. 이메일·메모·마케팅 동의는 저장하지 않는다) */
export type Customer = { id: string; tenantId: string; name: string; phone: string | null; version: number; anonymizedAt?: string };

/** 고객 변경 이력(추가 전용) */
export type CustomerChange = {
  id: string;
  tenantId: string;
  customerId: string;
  kind: "REGISTERED" | "UPDATED" | "ANONYMIZED";
  before?: { name: string; phone: string | null };
  after?: { name: string; phone: string | null };
  by: string;
  at: string;
};

export type RegisterCustomerDeps = {
  customers: { listByPhone(tenantId: string, phone: string): Customer[]; save(customer: Customer): void };
  customerChanges: { save(change: CustomerChange): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RegisterCustomerRequest = {
  tenantId: string;
  name: string;
  phone: string;
  actorRole: "OWNER" | "STAFF";
  registeredBy: string;
  registeredAt: string;
  idempotencyKey: string;
};

/** 같은 서점·같은 정규화 번호의 기존 고객. 이름까지 같으면 sameName=true. 자동 병합은 하지 않는다 */
export type DuplicateCandidate = { customer: Customer; sameName: boolean };

export function registerCustomer(deps: RegisterCustomerDeps, request: RegisterCustomerRequest): { customer: Customer; duplicateCandidates: DuplicateCandidate[] } {
  if (!isNonEmptyString(request.name)) invalid("name", "must be a non-empty string");
  if (!isNonEmptyString(request.registeredBy)) invalid("registeredBy", "must be a non-empty string");
  parseUtcTimestamp("registeredAt", request.registeredAt, (deps.now ?? (() => new Date()))());
  const name = request.name.trim();
  const phone = normalizePhone(request.phone);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "customer.register",
      key: request.idempotencyKey,
      payload: { name, phone, registeredBy: request.registeredBy, registeredAt: request.registeredAt },
    },
    () => {
      const duplicateCandidates = deps.customers
        .listByPhone(request.tenantId, phone)
        .map((existing): DuplicateCandidate => ({ customer: existing, sameName: existing.name === name }));
      const customer: Customer = { id: crypto.randomUUID(), tenantId: request.tenantId, name, phone, version: 1 };
      deps.customers.save(customer);
      deps.customerChanges.save({
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        customerId: customer.id,
        kind: "REGISTERED",
        by: request.registeredBy,
        at: request.registeredAt,
      });
      return { customer, duplicateCandidates };
    },
  );
}
