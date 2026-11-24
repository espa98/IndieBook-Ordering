import type { ReceiptAllocation } from "./allocateReceipt";
import type { AllocationCancellation } from "./cancelAllocation";
import type { AllocationDelivery } from "./deliverAllocation";
import type { AllocationRelease } from "./releaseAllocation";

export type AllocationState = {
  generated: number;
  released: number;
  remaining: number;
  status: "OPEN" | "CLOSED";
};

/** 원 배분 단위의 잔량 B=G-L-Fsrc-C(주문 취소 처분)와 상태 (BR-Q16). released는 해제량 L이다. */
export function allocationState(
  allocation: ReceiptAllocation,
  releases: readonly AllocationRelease[],
  deliveries: readonly AllocationDelivery[] = [],
  cancellations: readonly AllocationCancellation[] = [],
): AllocationState {
  const released = releases.reduce((sum, r) => sum + r.quantity, 0);
  const delivered = deliveries.reduce((sum, d) => sum + d.quantity, 0);
  const cancelled = cancellations.reduce((sum, c) => sum + c.quantity, 0);
  const remaining = allocation.quantity - released - delivered - cancelled;
  return {
    generated: allocation.quantity,
    released,
    remaining,
    status: remaining > 0 ? "OPEN" : "CLOSED",
  };
}
