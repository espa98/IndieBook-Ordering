import type { StockMovement } from "./registerInitialStock";
import type { StockReservation } from "./stockReservation";

export type StockLevel = { onHand: number; reserved: number; available: number };

/** 매장 풀의 보유(on_hand=원장 순합계)·예약·가용(available=on_hand-reserved) 수량 (BR-Q09, BR-Q10). */
export function stockLevel(
  movements: readonly StockMovement[],
  reservations: readonly StockReservation[],
): StockLevel {
  const onHand = movements.reduce(
    (sum, m) => sum + (m.direction === "IN" ? m.quantity : -m.quantity),
    0,
  );
  const reserved = reservations.reduce((sum, r) => sum + r.quantity, 0);
  return { onHand, reserved, available: onHand - reserved };
}
