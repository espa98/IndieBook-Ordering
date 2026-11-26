import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { normalizePhone } from "./normalizePhone";
import type { Customer, CustomerChange } from "./registerCustomer";

export type UpdateCustomerDeps = {
  customers: { get(tenantId: string, id: string): Customer | undefined; save(customer: Customer): void };
  customerChanges: { save(change: CustomerChange): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type UpdateCustomerRequest = {
  tenantId: string;
  customerId: string;
  expectedVersion: number;
  changes: { name?: string; phone?: string };
  actorRole: "OWNER" | "STAFF";
  changedBy: string;
  changedAt: string;
  idempotencyKey: string;
};

const view = (c: Customer) => ({ name: c.name, phone: c.phone });

/** 고객의 이름·번호를 수정한다(C-03). 변경 전·후 값은 추가 전용 이력에 남는다 */
export function updateCustomer(deps: UpdateCustomerDeps, request: UpdateCustomerRequest): Customer {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) invalid("expectedVersion", "must be an integer >= 1");
  const changes = request.changes ?? {};
  if (changes.name === undefined && changes.phone === undefined) invalid("changes", "at least one field must change");
  if (changes.name !== undefined && !isNonEmptyString(changes.name)) invalid("name", "must be a non-empty string");
  if (!isNonEmptyString(request.changedBy)) invalid("changedBy", "must be a non-empty string");
  parseUtcTimestamp("changedAt", request.changedAt, (deps.now ?? (() => new Date()))());
  const phone = changes.phone === undefined ? undefined : normalizePhone(changes.phone);
  const name = changes.name?.trim();
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "customer.update",
      key: request.idempotencyKey,
      payload: { customerId: request.customerId, expectedVersion: request.expectedVersion, name, phone, changedBy: request.changedBy, changedAt: request.changedAt },
    },
    () => {
      const customer = deps.customers.get(request.tenantId, request.customerId);
      if (!customer) throw new AppError("NOT_FOUND");
      if (customer.anonymizedAt !== undefined) throw new AppError("BUSINESS_INVARIANT", "an anonymized customer cannot be changed");
      if (customer.version !== request.expectedVersion) throw new AppError("VERSION_CONFLICT");
      const updated: Customer = { ...customer, ...(name === undefined ? {} : { name }), ...(phone === undefined ? {} : { phone }), version: customer.version + 1 };
      deps.customers.save(updated);
      deps.customerChanges.save({
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        customerId: customer.id,
        kind: "UPDATED",
        before: view(customer),
        after: view(updated),
        by: request.changedBy,
        at: request.changedAt,
      });
      return updated;
    },
  );
}
