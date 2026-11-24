import type { ReceiptAllocation } from "./allocateReceipt";
import type { AllocationDelivery } from "./deliverAllocation";
import type { AllocationRelease } from "./releaseAllocation";

export type AllocationState = {
  generated: number;
  released: number;
  remaining: number;
  status: "OPEN" | "CLOSED";
};

/** 원 배분 단위의 잔량 B=G-L-Fsrc와 상태 (BR-Q16). released는 해제량 L이다. */
export function allocationState(
  allocation: ReceiptAllocation,
  releases: readonly AllocationRelease[],
  deliveries: readonly AllocationDelivery[] = [],
): AllocationState {
  const released = releases.reduce((sum, r) => sum + r.quantity, 0);
  const delivered = deliveries.reduce((sum, d) => sum + d.quantity, 0);
  const remaining = allocation.quantity - released - delivered;
  return {
    generated: allocation.quantity,
    released,
    remaining,
    status: remaining > 0 ? "OPEN" : "CLOSED",
  };
}
