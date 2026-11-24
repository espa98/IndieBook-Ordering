import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type {
  RegisterSupplierRequest,
  SupplierChange,
} from "../../src/catalog/registerSupplier";
import { createInMemorySupplierRepository } from "./procurementFixtures";

/** 인메모리 공급처·변경 이력 저장소. 위임된 직원은 "staff-delegated" 하나다 */
export function supplierScene() {
  const suppliers = createInMemorySupplierRepository();
  const changes: SupplierChange[] = [];
  const deps = {
    suppliers,
    supplierChanges: { list: (t: string, code: string) => changes.filter((c) => c.tenantId === t && c.code === code), save: (c: SupplierChange) => void changes.push(c) },
    managementDelegations: { isDelegated: (tenantId: string, userId: string) => tenantId === "tenant-a" && userId === "staff-delegated" },
    idempotency: createIdempotencyStore(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const registerRequest = (extra: Partial<RegisterSupplierRequest> = {}): RegisterSupplierRequest => ({
    tenantId: "tenant-a",
    code: "sup-x",
    name: "엑스도매",
    orderChannel: "EMAIL",
    actorRole: "OWNER",
    registeredBy: "owner-1",
    registeredAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: `sup-${++seq}`,
    ...extra,
  });
  return { deps, suppliers, changes, registerRequest };
}
