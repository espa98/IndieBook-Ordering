import type { ReceiptAllocation } from "./allocateReceipt";
import type { AllocationRelease } from "./releaseAllocation";

export type AllocationState = {
  generated: number;
  released: number;
  remaining: number;
  status: "OPEN" | "CLOSED";
};

/** 원 배분 단위의 잔량 B=G-L (인도 Fsrc는 ST-R06에서 더한다)과 상태 (BR-Q16). */
export function allocationState(
  allocation: ReceiptAllocation,
  releases: readonly AllocationRelease[],
): AllocationState {
  const released = releases.reduce((sum, r) => sum + r.quantity, 0);
  const remaining = allocation.quantity - released;
  return {
    generated: allocation.quantity,
    released,
    remaining,
    status: remaining > 0 ? "OPEN" : "CLOSED",
  };
}
