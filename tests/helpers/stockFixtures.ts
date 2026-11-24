import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type {
  RegisterInitialStockRequest,
  StockMovement,
} from "../../src/inventory/registerInitialStock";

export function createInMemoryStockMovementRepository() {
  const all: StockMovement[] = [];
  return {
    list(tenantId: string, bookId: string): StockMovement[] {
      return all.filter((m) => m.tenantId === tenantId && m.bookId === bookId);
    },
    save(movement: StockMovement): void {
      all.push(movement);
    },
  };
}

/** 재고 원장이 비어 있는 세계 */
export function stockScene() {
  const stockMovements = createInMemoryStockMovementRepository();
  const deps = {
    stockMovements,
    idempotency: createIdempotencyStore(),
    now: () => new Date("2026-03-04T07:00:00.000Z"),
  };
  let seq = 0;
  const initialRequest = (
    extra: Partial<RegisterInitialStockRequest> = {},
  ): RegisterInitialStockRequest => ({
    tenantId: "tenant-a",
    bookId: "book-1",
    quantity: 5,
    actorRole: "OWNER",
    actedBy: "점주",
    actedAt: "2026-03-04T06:00:00.000Z",
    idempotencyKey: `init-${++seq}`,
    ...extra,
  });
  return { deps, stockMovements, initialRequest };
}
