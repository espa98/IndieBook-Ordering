import type { Order } from "../order/createDraftOrder";
import type { FulfillmentRepository } from "../fulfillment/postFulfillment";
import { allocationState } from "../inventory/allocationState";
import type { ReceiptAllocationRepository } from "../inventory/allocateReceipt";
import type { AllocationCancellationRepository } from "../inventory/cancelAllocation";
import type { AllocationDeliveryRepository } from "../inventory/deliverAllocation";
import type { AllocationReleaseRepository } from "../inventory/releaseAllocation";
import {
  readReservationLedger,
  type StockReservationRepository,
} from "../inventory/stockReservation";
import type { StockReservationDeliveryRepository } from "../inventory/deliverStockReservation";
import type { StockReservationReleaseRepository } from "../inventory/releaseStockReservation";

export type SecuredLine = {
  orderLineId: string;
  orderedQuantity: number;
  receivedQuantity: number;
  securedQuantity: number;
};

export type SecuredSnapshotDeps = {
  fulfillments: Pick<FulfillmentRepository, "list">;
  stockReservations: Pick<StockReservationRepository, "list">;
  stockReservationReleases: Pick<StockReservationReleaseRepository, "list">;
  stockReservationDeliveries: Pick<StockReservationDeliveryRepository, "list">;
  receiptAllocations: Pick<ReceiptAllocationRepository, "listByOrder">;
  allocationReleases: Pick<AllocationReleaseRepository, "list">;
  allocationDeliveries: Pick<AllocationDeliveryRepository, "list">;
  allocationCancellations: Pick<AllocationCancellationRepository, "list">;
};

/**
 * 주문 품목별 현재 "수령 가능 확보량"(매장 예약 R + 입고 배분 A의 미인도 잔량, BR-Q03/Q04)을 계산한다.
 * 기수령량은 수령 거래에서 가져온다.
 */
export function securedSnapshot(
  deps: SecuredSnapshotDeps,
  tenantId: string,
  order: Order,
): SecuredLine[] {
  const allocations = deps.receiptAllocations.listByOrder(tenantId, order.id);
  const received = deps.fulfillments.list(tenantId, order.id);
  return order.lines.map((line) => {
    const { reservations, releases, deliveries } = readReservationLedger(
      deps as never,
      tenantId,
      line.bookId,
    );
    const reserved = reservations
      .filter((r) => r.orderId === order.id && r.orderLineId === line.lineId)
      .reduce((sum, r) => {
        const released = releases
          .filter((x) => x.reservationId === r.id)
          .reduce((t, x) => t + x.quantity, 0);
        const delivered = deliveries
          .filter((x) => x.reservationId === r.id)
          .reduce((t, x) => t + x.quantity, 0);
        return sum + r.quantity - released - delivered;
      }, 0);
    const allocated = allocations
      .filter((a) => a.orderLineId === line.lineId)
      .reduce(
        (sum, a) =>
          sum +
          allocationState(
            a,
            deps.allocationReleases.list(tenantId, a.id),
            deps.allocationDeliveries.list(tenantId, a.id),
            deps.allocationCancellations.list(tenantId, a.id),
          ).remaining,
        0,
      );
    return {
      orderLineId: line.lineId,
      orderedQuantity: line.quantity,
      receivedQuantity: received
        .filter((f) => f.orderLineId === line.lineId)
        .reduce((sum, f) => sum + f.quantity, 0),
      securedQuantity: reserved + allocated,
    };
  });
}
