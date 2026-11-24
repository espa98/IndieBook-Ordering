import { AppError } from "../errors/AppError";
import type { Order } from "./createDraftOrder";

/**
 * 확정되었고 아직 종결되지 않은 주문에만 신규 중요 거래(결제·예약·조달·인도)를 추가할 수 있다.
 * 종결된 주문은 정정·재개 경로로만, 전량 취소된 주문(CANCELLING)은 후속 물량·금전 업무(환급·처분)만 계속할 수 있다 (BR-O07, BR-O08, ST-O10).
 */
export function assertOrderOpenForTransactions(order: Order, action: string): void {
  if (order.status !== "CONFIRMED") {
    throw new AppError("BUSINESS_INVARIANT", `${action} requires a confirmed order`);
  }
  if (order.cancelledAt !== undefined) {
    throw new AppError("BUSINESS_INVARIANT", `${action} is not allowed on a fully cancelled order`);
  }
  if (order.closedAt !== undefined) {
    throw new AppError("BUSINESS_INVARIANT", `${action} is not allowed on a closed order`);
  }
}
