import type { StockReservationReleaseRepository, StockReservationRelease } from "./releaseStockReservation";

/**
 * 주문 품목에 대한 매장 재고 예약 (ST-I03에서 생성한다).
 * quantity는 생성량이고, 해제·인도(ST-I04/I05)로 줄어든 잔량이 예약량이다.
 */
export type StockReservation = {
  id: string;
  tenantId: string;
  bookId: string;
  orderId: string;
  orderLineId: string;
  quantity: number;
};

export type StockReservationRepository = {
  get(tenantId: string, id: string): StockReservation | undefined;
  list(tenantId: string, bookId: string): StockReservation[];
  save(reservation: StockReservation): void;
};

/** 도서의 예약 기록과 그 예약들에 대한 해제 기록을 함께 읽는다. */
export function readReservationLedger(
  deps: {
    stockReservations: Pick<StockReservationRepository, "list">;
    stockReservationReleases: Pick<StockReservationReleaseRepository, "list">;
  },
  tenantId: string,
  bookId: string,
): { reservations: StockReservation[]; releases: StockReservationRelease[] } {
  const reservations = deps.stockReservations.list(tenantId, bookId);
  const releases = reservations.flatMap((r) =>
    deps.stockReservationReleases.list(tenantId, r.id),
  );
  return { reservations, releases };
}
