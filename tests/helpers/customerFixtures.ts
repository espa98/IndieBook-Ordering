import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type { Customer, CustomerChange, RegisterCustomerRequest } from "../../src/customer/registerCustomer";

export function customerScene() {
  const customers: Customer[] = [];
  const changes: CustomerChange[] = [];
  const deps = {
    customers: {
      list: (tenantId: string) => customers.filter((c) => c.tenantId === tenantId),
      get: (tenantId: string, id: string) => customers.find((c) => c.tenantId === tenantId && c.id === id),
      listByPhone: (tenantId: string, phone: string) => customers.filter((c) => c.tenantId === tenantId && c.phone === phone),
      save: (c: Customer) => {
        const at = customers.findIndex((x) => x.id === c.id);
        if (at >= 0) customers[at] = c;
        else customers.push(c);
      },
    },
    customerChanges: { save: (c: CustomerChange) => void changes.push(c) },
    idempotency: createIdempotencyStore(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const request = (extra: Partial<RegisterCustomerRequest> = {}): RegisterCustomerRequest => ({
    tenantId: "tenant-a",
    name: "김독자",
    phone: "010-1234-5678",
    actorRole: "STAFF",
    registeredBy: "staff-1",
    registeredAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: `cus-${++seq}`,
    ...extra,
  });
  return { deps, customers, changes, request };
}
