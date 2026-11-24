import type { RefundConfirmation } from "./confirmRefund";
import type { RefundTask } from "./openRefundTask";

export type RefundTaskState = {
  requiredKrw: string;
  refundedKrw: string;
  remainingKrw: string;
  status: "REFUND_REQUIRED" | "PARTIAL" | "REFUNDED";
};

/** 환급 업무의 상태·잔량은 환급 확인 기록에서 파생한다. 업무는 실제 완료액으로만 종료된다 (BR-Y07). */
export function refundTaskState(
  task: RefundTask,
  refunds: readonly RefundConfirmation[],
): RefundTaskState {
  const required = BigInt(task.requiredKrw);
  const refunded = refunds.reduce((sum, r) => sum + BigInt(r.amountKrw), 0n);
  const remaining = required > refunded ? required - refunded : 0n;
  return {
    requiredKrw: required.toString(),
    refundedKrw: refunded.toString(),
    remainingKrw: remaining.toString(),
    status: refunded === 0n ? "REFUND_REQUIRED" : remaining === 0n ? "REFUNDED" : "PARTIAL",
  };
}
