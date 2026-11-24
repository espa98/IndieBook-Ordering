import type { StockMovement } from "./registerInitialStock";
import type { StockReservationDelivery } from "./deliverStockReservation";
import type { StockReservationRelease } from "./releaseStockReservation";
import type { StockReservation } from "./stockReservation";

export type StockLevel = { onHand: number; reserved: number; available: number };

/** 매장 풀의 보유(on_hand=원장 순합계)·예약·가용(available=on_hand-reserved) 수량 (BR-Q09, BR-Q10). */
export function stockLevel(
  movements: readonly StockMovement[],
  reservations: readonly StockReservation[],
  releases: readonly StockReservationRelease[] = [],
  deliveries: readonly StockReservationDelivery[] = [],
): StockLevel {
  const onHand = movements.reduce(
    (sum, m) => sum + (m.direction === "IN" ? m.quantity : -m.quantity),
    0,
  );
  // 미인도 예약량 R = 생성 - 해제 - 인도 (BR-Q03). 인도된 양은 보유 원장에서도 빠져 있다.
  const sum = (items: readonly { quantity: number }[]) =>
    items.reduce((total, i) => total + i.quantity, 0);
  const reserved = sum(reservations) - sum(releases) - sum(deliveries);
  return { onHand, reserved, available: onHand - reserved };
}
