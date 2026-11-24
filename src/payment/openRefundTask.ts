import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import type { OrderRepository } from "../order/confirmOrderService";
import type { PaymentCorrectionRepository } from "./correctPayment";
import type { RefundConfirmationRepository } from "./confirmRefund";
import { refundTaskState } from "./refundTaskState";
import type { PaymentConfirmationRepository } from "./confirmPayment";
import { paymentSummary } from "./paymentSummary";
import type { PaymentRepository } from "./recordPayment";
import type { PaymentVoidRepository } from "./voidPayment";

/**
 * 환급 필요 업무 (추가 전용, ST-Y05). 과수납분을 환급해야 한다는 금전 업무이며 물량 처리와 독립이다.
 * 업무의 진행·완료는 환급 확인 기록에서 파생한다 (BR-Y07).
 */
export type RefundTask = {
  id: string;
  tenantId: string;
  orderId: string;
  requiredKrw: string;
  openedBy: string;
  openedAt: string;
  recordedAt: string;
};

export type RefundTaskRepository = {
  get(tenantId: string, id: string): RefundTask | undefined;
  list(tenantId: string, orderId: string): RefundTask[];
  save(task: RefundTask): void;
};

export type OpenRefundTaskDeps = {
  orders: OrderRepository;
  payments: PaymentRepository;
  paymentConfirmations: Pick<PaymentConfirmationRepository, "list">;
  paymentVoids: Pick<PaymentVoidRepository, "list">;
  paymentCorrections: Pick<PaymentCorrectionRepository, "listByOrder">;
  refundTasks: RefundTaskRepository;
  refundConfirmations: Pick<RefundConfirmationRepository, "list" | "listByOrder">;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type OpenRefundTaskRequest = {
  tenantId: string;
  orderId: string;
  openedBy: string;
  openedAt: string;
  idempotencyKey: string;
};

export function openRefundTask(
  deps: OpenRefundTaskDeps,
  request: OpenRefundTaskRequest,
): RefundTask {
  if (!isNonEmptyString(request.openedBy)) {
    invalid("openedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("openedAt", request.openedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.open-refund-task",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        openedBy: request.openedBy,
        openedAt: request.openedAt,
      },
    },
    () => {
      const order = deps.orders.get(request.tenantId, request.orderId);
      if (!order) {
        throw new AppError("NOT_FOUND");
      }
      const payments = deps.payments.list(request.tenantId, order.id);
      const summary = paymentSummary(
        order,
        payments,
        payments.flatMap((p) => deps.paymentConfirmations.list(request.tenantId, p.id)),
        payments.flatMap((p) => deps.paymentVoids.list(request.tenantId, p.id)),
        deps.refundConfirmations.listByOrder(request.tenantId, order.id),
        deps.paymentCorrections.listByOrder(request.tenantId, order.id),
      );
      if (BigInt(summary.refundRequiredKrw) < 1n) {
        throw new AppError("BUSINESS_INVARIANT", "there is no overpayment to refund");
      }
      // 활성(미완료) 환급 업무는 주문당 하나다. 완료 여부는 환급 확인 기록에서 파생한다 (BR-Y07)
      const hasActiveTask = deps.refundTasks
        .list(request.tenantId, order.id)
        .some(
          (t) =>
            refundTaskState(t, deps.refundConfirmations.list(request.tenantId, t.id)).status !==
            "REFUNDED",
        );
      if (hasActiveTask) {
        throw new AppError("BUSINESS_INVARIANT", "a refund task is already open for this order");
      }
      const task: RefundTask = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: order.id,
        requiredKrw: summary.refundRequiredKrw,
        openedBy: request.openedBy,
        openedAt: request.openedAt,
        recordedAt: now.toISOString(),
      };
      deps.refundTasks.save(task);
      return task;
    },
  );
}
