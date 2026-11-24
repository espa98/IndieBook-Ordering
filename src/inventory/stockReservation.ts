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
  list(tenantId: string, bookId: string): StockReservation[];
  save(reservation: StockReservation): void;
};
