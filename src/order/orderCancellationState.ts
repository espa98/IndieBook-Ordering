import type {
  OrderCancellationDecision,
  OrderCancellationRequest,
} from "./requestOrderCancellation";

export type OrderCancellationStatus =
  | "REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "STALE"
  | "APPLIED";

/**
 * 취소 요청 상태는 결정 기록에서 파생한다 (BR-O05).
 * REQUESTED → APPROVED/REJECTED/WITHDRAWN, APPROVED → APPLIED/STALE. 승인 자체는 수량을 바꾸지 않는다.
 */
export function orderCancellationStatus(
  decisions: readonly OrderCancellationDecision[],
): OrderCancellationStatus {
  let status: OrderCancellationStatus = "REQUESTED";
  for (const decision of decisions) status = decision.kind;
  return status;
}

/** 진행 중(REQUESTED·APPROVED)인 요청의 수량은 인도할 수 없도록 잠긴다 (D27). */
export function activeCancellationLock(
  requests: readonly OrderCancellationRequest[],
  decisionsOf: (requestId: string) => readonly OrderCancellationDecision[],
  orderLineId: string,
): number {
  return requests
    .filter((r) => r.orderLineId === orderLineId)
    .filter((r) => {
      const status = orderCancellationStatus(decisionsOf(r.id));
      return status === "REQUESTED" || status === "APPROVED";
    })
    .reduce((sum, r) => sum + r.quantity, 0);
}
