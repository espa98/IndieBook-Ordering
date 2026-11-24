import { cancellationOpenQuantity } from "../inventory/cancellationOpen";
import type { ReceiptAllocationRepository } from "../inventory/allocateReceipt";
import type { AllocationCancellationRepository } from "../inventory/cancelAllocation";
import type { ReturnCompletionRepository } from "../inventory/completeReturn";
import type { ReturnExceptionRepository } from "../inventory/reportReturnException";
import type { ReturnExceptionResolutionRepository } from "../inventory/resolveReturnException";
import type { ReturnRequestRepository } from "../inventory/requestReturn";
import type { StockIntakeRepository } from "../inventory/transferCancelledToStock";
import type { FulfillmentRepository } from "../fulfillment/postFulfillment";
import type { PaymentConfirmationRepository } from "../payment/confirmPayment";
import type { RefundConfirmationRepository } from "../payment/confirmRefund";
import type { PaymentCorrectionRepository } from "../payment/correctPayment";
import type { RefundTaskRepository } from "../payment/openRefundTask";
import { paymentSummary } from "../payment/paymentSummary";
import { refundTaskState } from "../payment/refundTaskState";
import type { PaymentRepository } from "../payment/recordPayment";
import type { PaymentVoidRepository } from "../payment/voidPayment";
import type { Order } from "./createDraftOrder";

export type ClosureBlocker =
  | "UNDELIVERED"
  | "UNPAID_BALANCE"
  | "PAYMENT_PENDING_VERIFICATION"
  | "REFUND_REQUIRED"
  | "REFUND_OPEN"
  | "DISPOSITION_OPEN";

export type OrderClosureEvaluation = {
  closable: boolean;
  blockers: ClosureBlocker[];
};

export type EvaluateOrderClosureDeps = {
  fulfillments: Pick<FulfillmentRepository, "list">;
  payments: Pick<PaymentRepository, "list">;
  paymentConfirmations: Pick<PaymentConfirmationRepository, "list">;
  paymentVoids: Pick<PaymentVoidRepository, "list">;
  refundConfirmations: Pick<RefundConfirmationRepository, "list" | "listByOrder">;
  refundTasks: Pick<RefundTaskRepository, "list">;
  paymentCorrections: Pick<PaymentCorrectionRepository, "listByOrder">;
  receiptAllocations: Pick<ReceiptAllocationRepository, "listByOrder">;
  allocationCancellations: Pick<AllocationCancellationRepository, "list">;
  stockIntakes: Pick<StockIntakeRepository, "list">;
  returnRequests: Pick<ReturnRequestRepository, "list">;
  returnCompletions: Pick<ReturnCompletionRepository, "list">;
  returnExceptions: Pick<ReturnExceptionRepository, "list">;
  returnExceptionResolutions: Pick<ReturnExceptionResolutionRepository, "list">;
};

/**
 * 정상 종결 가능 여부를 기록에서 계산한다 (BR-O01): 모든 품목 F=E, 결제 정책 충족(잔액 0),
 * 필수 미해결 업무 없음. 고객 안내는 종결 조건이 아니다 (DEC-10, BR-O04).
 */
export function evaluateOrderClosure(
  deps: EvaluateOrderClosureDeps,
  tenantId: string,
  order: Order,
): OrderClosureEvaluation {
  const blockers: ClosureBlocker[] = [];
  const received = deps.fulfillments.list(tenantId, order.id);
  const undelivered = order.lines.some(
    (line) =>
      received
        .filter((f) => f.orderLineId === line.lineId)
        .reduce((sum, f) => sum + f.quantity, 0) < line.quantity,
  );
  if (undelivered) blockers.push("UNDELIVERED");

  const payments = deps.payments.list(tenantId, order.id);
  const summary = paymentSummary(
    order,
    payments,
    payments.flatMap((p) => deps.paymentConfirmations.list(tenantId, p.id)),
    payments.flatMap((p) => deps.paymentVoids.list(tenantId, p.id)),
    deps.refundConfirmations.listByOrder(tenantId, order.id),
    deps.paymentCorrections.listByOrder(tenantId, order.id),
  );
  if (BigInt(summary.balanceKrw) > 0n) blockers.push("UNPAID_BALANCE");
  // 입력만 되고 확인·무효가 되지 않은 거래가 있으면 처리 중인 결제가 있는 것이다
  if (BigInt(summary.pendingKrw) > 0n) blockers.push("PAYMENT_PENDING_VERIFICATION");
  // 환급은 금전 업무라 물량과 독립으로 완료되어야 한다 (BR-Y05/Y06, DEC-10)
  const activeRefundTask = deps.refundTasks
    .list(tenantId, order.id)
    .some(
      (t) => refundTaskState(t, deps.refundConfirmations.list(tenantId, t.id)).status !== "REFUNDED",
    );
  if (activeRefundTask) blockers.push("REFUND_OPEN");
  else if (BigInt(summary.refundRequiredKrw) > 0n) blockers.push("REFUND_REQUIRED");

  // 주문 때문에 입고 배분이 취소된 물량의 처분(반품·편입)이 끝나지 않았으면 종결할 수 없다 (BR-O02, BR-P06)
  const dispositionOpen = deps.receiptAllocations
    .listByOrder(tenantId, order.id)
    .flatMap((a) => deps.allocationCancellations.list(tenantId, a.id))
    .some((c) => cancellationOpenQuantity(deps, tenantId, c) > 0);
  if (dispositionOpen) blockers.push("DISPOSITION_OPEN");

  return { closable: blockers.length === 0, blockers };
}
