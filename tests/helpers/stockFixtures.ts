import type { ReserveStockRequest } from "../../src/inventory/reserveStock";
import { world } from "./procurementWorld";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import type { StockReservation } from "../../src/inventory/stockReservation";
import type { AdjustStockRequest } from "../../src/inventory/adjustStock";
import { registerInitialStock } from "../../src/inventory/registerInitialStock";
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

export function createInMemoryStockReservationRepository() {
  const all: StockReservation[] = [];
  return {
    list(tenantId: string, bookId: string): StockReservation[] {
      return all.filter((r) => r.tenantId === tenantId && r.bookId === bookId);
    },
    save(reservation: StockReservation): void {
      all.push(reservation);
    },
  };
}

/** book-1 재고 5권이 Owner에 의해 초기 등록된 세계 */
export function adjustScene() {
  const base = stockScene();
  const stockReservations = createInMemoryStockReservationRepository();
  // 점주가 재고 조정을 명시적으로 위임한 직원 (DEC-19)
  const delegated = new Set<string>();
  const stockDelegations = {
    isDelegated: (tenantId: string, userId: string) => delegated.has(`${tenantId}:${userId}`),
    grant: (tenantId: string, userId: string) => void delegated.add(`${tenantId}:${userId}`),
  };
  const s = {
    ...base,
    deps: { ...base.deps, stockReservations, stockDelegations },
    stockReservations,
    stockDelegations,
  };
  registerInitialStock(s.deps, s.initialRequest({ quantity: 5 }));
  let seq = 0;
  const adjustRequest = (
    extra: Partial<AdjustStockRequest> = {},
  ): AdjustStockRequest => ({
    tenantId: "tenant-a",
    bookId: "book-1",
    direction: "IN",
    quantity: 3,
    reason: "실사 결과 3권 추가 발견",
    actorRole: "OWNER",
    actedBy: "점주",
    actedAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: `adj-${++seq}`,
    ...extra,
  });
  return { ...s, adjustRequest };
}

/** book-1 재고 5권이 있고, 고객 주문(book-1 2권, 확정)이 있는 세계 */
export function reservationScene() {
  const a = adjustScene();
  const w = world();
  const order = w.addOrder([{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }]);
  const deps = { ...a.deps, orders: w.deps.orders, sourcingAllocations: w.deps.allocations };
  let seq = 0;
  const reserveRequest = (
    extra: Partial<ReserveStockRequest> = {},
  ): ReserveStockRequest => ({
    tenantId: "tenant-a",
    orderId: order.id,
    orderLineId: order.lines[0]!.lineId,
    quantity: 2,
    reservedBy: "김직원",
    reservedAt: "2026-03-04T06:40:00.000Z",
    idempotencyKey: `res-${++seq}`,
    ...extra,
  });
  return { ...a, w, deps, order, reserveRequest };
}
