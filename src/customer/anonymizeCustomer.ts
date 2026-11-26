import { AppError } from "../errors/AppError";
import { executeIdempotent, type IdempotencyStore } from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { Customer, CustomerChange } from "./registerCustomer";

export type AnonymizeCustomerDeps = {
  customers: { get(tenantId: string, id: string): Customer | undefined; save(customer: Customer): void };
  customerChanges: { save(change: CustomerChange): void };
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type AnonymizeCustomerRequest = {
  tenantId: string;
  customerId: string;
  expectedVersion: number;
  actorRole: "OWNER" | "STAFF";
  anonymizedBy: string;
  anonymizedAt: string;
  idempotencyKey: string;
};

export const ANONYMIZED_NAME = "(익명)";

/**
 * 삭제 요청은 익명화로 처리한다(Owner만, 고객 결정 #2·#10). 이름·번호를 비식별화하되 고객 ID와 연결된 주문 이력은 유지한다.
 * 원래 값은 추가 전용 이력의 변경 전 값에만 남는다(보존기간 결정은 DEC-12 법률 검토를 따른다).
 */
export function anonymizeCustomer(deps: AnonymizeCustomerDeps, request: AnonymizeCustomerRequest): Customer {
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) invalid("expectedVersion", "must be an integer >= 1");
  if (!isNonEmptyString(request.anonymizedBy)) invalid("anonymizedBy", "must be a non-empty string");
  parseUtcTimestamp("anonymizedAt", request.anonymizedAt, (deps.now ?? (() => new Date()))());
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "customer.anonymize",
      key: request.idempotencyKey,
      payload: { customerId: request.customerId, expectedVersion: request.expectedVersion, anonymizedBy: request.anonymizedBy, anonymizedAt: request.anonymizedAt },
    },
    () => {
      const customer = deps.customers.get(request.tenantId, request.customerId);
      if (!customer) throw new AppError("NOT_FOUND");
      if (customer.anonymizedAt !== undefined) throw new AppError("BUSINESS_INVARIANT", "an anonymized customer cannot be changed");
      if (customer.version !== request.expectedVersion) throw new AppError("VERSION_CONFLICT");
      const anonymized: Customer = { id: customer.id, tenantId: customer.tenantId, name: ANONYMIZED_NAME, phone: null, anonymizedAt: request.anonymizedAt, version: customer.version + 1 };
      deps.customers.save(anonymized);
      deps.customerChanges.save({
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        customerId: customer.id,
        kind: "ANONYMIZED",
        before: { name: customer.name, phone: customer.phone },
        after: { name: anonymized.name, phone: null },
        by: request.anonymizedBy,
        at: request.anonymizedAt,
      });
      return anonymized;
    },
  );
}
