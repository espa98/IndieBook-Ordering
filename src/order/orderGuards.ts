import { AppError } from "../errors/AppError";
import type { Order } from "./createDraftOrder";

/**
 * 확정되었고 아직 종결되지 않은 주문에만 신규 중요 거래(결제·예약·조달·인도)를 추가할 수 있다.
 * 종결된 주문은 정정·재개 경로로만 다시 연다 (BR-O08, ST-O10).
 */
export function assertOrderOpenForTransactions(order: Order, action: string): void {
  if (order.status !== "CONFIRMED") {
    throw new AppError("BUSINESS_INVARIANT", `${action} requires a confirmed order`);
  }
  if (order.closedAt !== undefined) {
    throw new AppError("BUSINESS_INVARIANT", `${action} is not allowed on a closed order`);
  }
}
