import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { PurchaseOrderRepository } from "./createPurchaseOrder";
import { cancellationRequestState } from "./cancellationRequestState";
import { poLineState } from "./poLineState";
import type { PoReplyRepository } from "./recordSupplierReply";
import { invalid, isNonEmptyString } from "./validation";

/**
 * 공급처 취소 요청 (ST-P08). 요청만으로는 발주 수량·상태를 바꾸지 않는다 (PO-010).
 * 고객 취소와는 별개이며, 공급처가 수락한 수량만 외부 의무를 차감한다 (DEC-04).
 */
export type CancellationRequest = {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  poLineId: string;
  /** 취소를 요청한 수량 */
  quantity: number;
  reason: string;
  /** 서버 기록 시각 */
  requestedAt: string;
};

/** 공급처가 취소 요청에 응답한 기록 (추가 전용). 한 요청에 여러 번 나눠 응답할 수 있다 (BR-P02). */
export type CancellationResponse = {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  poLineId: string;
  /** 원 요청 참조: 중복 회신은 이 참조로 차단한다 (BR-P02) */
  requestId: string;
  acceptedQuantity: number;
  rejectedQuantity: number;
  evidence: string;
  /** 업무 발생 시각: 실제로 회신을 받은 시각 */
  repliedAt: string;
  /** 서버 기록 시각 */
  recordedAt: string;
};

export type CancellationRepository = {
  getRequest(tenantId: string, id: string): CancellationRequest | undefined;
  listRequests(tenantId: string, purchaseOrderId: string): CancellationRequest[];
  saveRequest(request: CancellationRequest): void;
  listResponses(tenantId: string, purchaseOrderId: string): CancellationResponse[];
  saveResponse(response: CancellationResponse): void;
};

export type CreateCancellationRequestDeps = {
  purchaseOrders: PurchaseOrderRepository;
  replies: PoReplyRepository;
  cancellations: CancellationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type CreateCancellationRequestRequest = {
  tenantId: string;
  purchaseOrderId: string;
  poLineId: string;
  quantity: number;
  reason: string;
  idempotencyKey: string;
};

export function createCancellationRequest(
  deps: CreateCancellationRequestDeps,
  request: CreateCancellationRequestRequest,
): CancellationRequest {
  if (!isNonEmptyString(request.purchaseOrderId)) {
    invalid("purchaseOrderId", "must be a non-empty string");
  }
  if (!isNonEmptyString(request.poLineId)) {
    invalid("poLineId", "must be a non-empty string");
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (!isNonEmptyString(request.reason)) {
    invalid("reason", "must be a non-empty string");
  }

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.cancellation-request",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        poLineId: request.poLineId,
        quantity: request.quantity,
        reason: request.reason,
      },
    },
    () => {
      const po = deps.purchaseOrders.get(request.tenantId, request.purchaseOrderId);
      if (!po) {
        // 없는 발주와 타 테넌트의 발주는 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      if (po.status !== "SENT" && po.status !== "ACKNOWLEDGED") {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "a cancellation can only be requested for a SENT or ACKNOWLEDGED purchase order",
        );
      }
      const line = po.lines.find((l) => l.poLineId === request.poLineId);
      if (!line) {
        throw new AppError("NOT_FOUND");
      }

      // 요청 가능 수량 = 현재 Qvalid − 아직 응답받지 못한 기존 요청의 미응답량.
      // 같은 수량을 두 번 요청해 외부 의무를 이중으로 줄이는 것을 막는다.
      // 수락된 취소는 Qvalid를 줄이고(별도 차감), 거절된 수량은 미응답에서 빠지므로 다시 요청할 수 있다.
      const responses = deps.cancellations.listResponses(request.tenantId, po.id);
      const acceptedCancel = responses
        .filter((r) => r.poLineId === line.poLineId)
        .reduce((sum, r) => sum + r.acceptedQuantity, 0);
      const { qvalid } = poLineState(
        line.quantity,
        deps.replies
          .list(request.tenantId, po.id)
          .filter((r) => r.poLineId === line.poLineId),
        acceptedCancel,
      );
      const openUnanswered = deps.cancellations
        .listRequests(request.tenantId, po.id)
        .filter((r) => r.poLineId === line.poLineId)
        .reduce(
          (sum, r) =>
            sum +
            cancellationRequestState(
              r.quantity,
              responses.filter((x) => x.requestId === r.id),
            ).unanswered,
          0,
        );
      if (request.quantity > qvalid - openUnanswered) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "requested quantity exceeds the quantity still available to cancel",
        );
      }

      const created: CancellationRequest = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        purchaseOrderId: po.id,
        poLineId: request.poLineId,
        quantity: request.quantity,
        reason: request.reason,
        requestedAt: (deps.now ?? (() => new Date()))().toISOString(),
      };
      deps.cancellations.saveRequest(created);
      return created;
    },
  );
}
