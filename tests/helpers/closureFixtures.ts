import { createInMemoryPaymentCorrectionRepository, createInMemoryRefundConfirmationRepository, createInMemoryRefundTaskRepository } from "./paymentFixtures";
import {
  createInMemoryReturnCompletionRepository,
  createInMemoryReturnDispatchRepository,
  createInMemoryReturnExceptionRepository,
  createInMemoryReturnExceptionResolutionRepository,
  createInMemoryReturnReplyRepository,
  createInMemoryReturnRequestRepository,
  createInMemoryStockIntakeRepository,
} from "./inventoryFixtures";
import type {
  ExecuteOrderClosureRequest,
  OrderClosure,
} from "../../src/order/executeOrderClosure";
import { requestOrderClosure } from "../../src/order/requestOrderClosure";
import type {
  OrderClosureRequest,
  RequestOrderClosureRequest,
} from "../../src/order/requestOrderClosure";
import { correctPayment } from "../../src/payment/correctPayment";
import { executeOrderClosure } from "../../src/order/executeOrderClosure";
import type {
  ExecuteOrderReopeningRequest,
  OrderReopening,
} from "../../src/order/executeOrderReopening";
import { postFulfillment } from "../../src/fulfillment/postFulfillment";
import { fulfillmentScene } from "./fulfillmentFixtures";

/**
 * 종결 판정에 필요한 모든 기록 저장소가 있는 세계.
 * 주문 D(2권, 예약 2): 결제·인도 전. 주문 B(3권, 입고 배분 3): 결제·인도 전.
 */
export function closureScene() {
  const f = fulfillmentScene();
  const stockIntakes = createInMemoryStockIntakeRepository();
  const returnRequests = createInMemoryReturnRequestRepository();
  const returnReplies = createInMemoryReturnReplyRepository();
  const returnDispatches = createInMemoryReturnDispatchRepository();
  const returnCompletions = createInMemoryReturnCompletionRepository();
  const returnExceptions = createInMemoryReturnExceptionRepository();
  const returnExceptionResolutions = createInMemoryReturnExceptionResolutionRepository();
  const refundTasks = createInMemoryRefundTaskRepository();
  const refundConfirmations = createInMemoryRefundConfirmationRepository();
  const paymentCorrections = createInMemoryPaymentCorrectionRepository();
  const deps = {
    ...f.deps,
    stockIntakes,
    returnRequests,
    returnReplies,
    returnDispatches,
    returnCompletions,
    returnExceptions,
    returnExceptionResolutions,
    refundTasks,
    refundConfirmations,
    paymentCorrections,
  };
  /** 주문 D를 결제 확인 후 전량 인도해 종결 가능한 상태로 만든다 */
  const completeOrderD = () => {
    f.pay(f.orderD.id, "30000");
    return f.fulfillRequest;
  };
  return { ...f, deps, completeOrderD };
}

export function createInMemoryOrderClosureRequestRepository() {
  const all: OrderClosureRequest[] = [];
  return {
    get(tenantId: string, id: string): OrderClosureRequest | undefined {
      return all.find((r) => r.tenantId === tenantId && r.id === id);
    },
    list(tenantId: string, orderId: string): OrderClosureRequest[] {
      return all.filter((r) => r.tenantId === tenantId && r.orderId === orderId);
    },
    save(request: OrderClosureRequest): void {
      all.push(request);
    },
  };
}

/** closureScene에서 종결을 요청할 수 있는 세계 */
export function closureRequestScene() {
  const s = closureScene();
  const closureRequests = createInMemoryOrderClosureRequestRepository();
  const deps = { ...s.deps, closureRequests };
  let seq = 0;
  const closureRequest = (
    extra: Partial<RequestOrderClosureRequest> = {},
  ): RequestOrderClosureRequest => ({
    tenantId: "tenant-a",
    orderId: s.orderD.id,
    expectedVersion: s.orderD.version,
    requestedBy: "김직원",
    requestedAt: "2026-03-04T06:58:00.000Z",
    idempotencyKey: `clr-${++seq}`,
    ...extra,
  });
  return { ...s, deps, closureRequests, closureRequest };
}

export function createInMemoryOrderClosureRepository() {
  const all: OrderClosure[] = [];
  return {
    list(tenantId: string, orderId: string): OrderClosure[] {
      return all.filter((c) => c.tenantId === tenantId && c.orderId === orderId);
    },
    save(closure: OrderClosure): void {
      all.push(closure);
    },
  };
}

/** 주문 D가 결제 확인·전량 인도까지 끝났고 Staff가 종결을 요청한 세계 */
export function executionScene() {
  const s = closureRequestScene();
  const orderClosures = createInMemoryOrderClosureRepository();
  const deps = { ...s.deps, orderClosures };
  s.pay(s.orderD.id, "30000");
  postFulfillment(
    deps,
    s.fulfillRequest({ sources: [{ kind: "STOCK_RESERVATION", sourceId: s.reservation.id, quantity: 2 }] }),
  );
  const request = requestOrderClosure(deps, s.closureRequest({ idempotencyKey: "clr-scene" }));
  let seq = 0;
  const executeRequest = (
    extra: Partial<ExecuteOrderClosureRequest> = {},
  ): ExecuteOrderClosureRequest => ({
    tenantId: "tenant-a",
    closureRequestId: request.id,
    executedBy: "SYSTEM",
    executedAt: "2026-03-04T06:59:00.000Z",
    idempotencyKey: `clx-${++seq}`,
    ...extra,
  });
  return { ...s, deps, orderClosures, closureRequestRecord: request, executeRequest };
}

export function createInMemoryOrderReopeningRepository() {
  const all: OrderReopening[] = [];
  return {
    list(tenantId: string, orderId: string): OrderReopening[] {
      return all.filter((r) => r.tenantId === tenantId && r.orderId === orderId);
    },
    save(reopening: OrderReopening): void {
      all.push(reopening);
    },
  };
}

/** 주문 D가 결제·인도를 마치고 서버가 종결한 세계. Owner가 결제 오기록을 보정할 수 있다. */
export function reopeningScene() {
  const s = executionScene();
  const orderReopenings = createInMemoryOrderReopeningRepository();
  const deps = { ...s.deps, orderReopenings };
  executeOrderClosure(deps, s.executeRequest({ idempotencyKey: "clx-reopen-scene" }));
  const paymentId = deps.payments.list("tenant-a", s.orderD.id)[0]!.id;
  /** 확인된 30,000원 결제를 Owner가 reducedKrw만큼 감액 보정하고 그 보정 기록을 돌려준다 */
  const correctOrderPayment = (reducedKrw: string, key = "pcr-reopen") =>
    correctPayment(deps, {
      tenantId: "tenant-a",
      paymentId,
      reducedKrw,
      reason: "입금액 오입력 정정",
      evidence: "은행 입금 내역 재확인",
      actorRole: "OWNER",
      correctedBy: "점주",
      correctedAt: "2026-03-04T06:59:30.000Z",
      idempotencyKey: key,
    });
  let seq = 0;
  const reopenRequest = (
    correctionId: string,
    extra: Partial<ExecuteOrderReopeningRequest> = {},
  ): ExecuteOrderReopeningRequest => ({
    tenantId: "tenant-a",
    orderId: s.orderD.id,
    trigger: { kind: "PAYMENT_CORRECTION", id: correctionId },
    executedBy: "SYSTEM",
    executedAt: "2026-03-04T06:59:45.000Z",
    idempotencyKey: `reo-${++seq}`,
    ...extra,
  });
  return { ...s, deps, orderReopenings, paymentId, correctOrderPayment, reopenRequest };
}
