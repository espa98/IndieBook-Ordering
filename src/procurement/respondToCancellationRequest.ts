import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { cancellationRequestState } from "./cancellationRequestState";
import type {
  CancellationRepository,
  CancellationResponse,
} from "./createCancellationRequest";
import type { PurchaseOrderRepository } from "./createPurchaseOrder";
import { poLineState } from "./poLineState";
import type { PoReplyRepository } from "./recordSupplierReply";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "./validation";

export type RespondToCancellationRequestDeps = {
  purchaseOrders: PurchaseOrderRepository;
  replies: PoReplyRepository;
  cancellations: CancellationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RespondToCancellationRequestRequest = {
  tenantId: string;
  purchaseOrderId: string;
  cancellationRequestId: string;
  acceptedQuantity: number;
  rejectedQuantity: number;
  evidence: string;
  /** 실제로 회신을 받은 시각(RFC3339 UTC) */
  repliedAt: string;
  idempotencyKey: string;
};

/**
 * 공급처가 취소 요청에 응답한 사실을 기록한다 (ST-P08, BR-P02).
 * 공급처가 수락한 수량만 외부 의무를 차감한다(DEC-04). 응답은 발주 상태를 바꾸지 않는다.
 * 모든 불변식은 저장하기 전에 확인하므로, 위반하면 아무것도 바뀌지 않는다.
 */
export function respondToCancellationRequest(
  deps: RespondToCancellationRequestDeps,
  request: RespondToCancellationRequestRequest,
): CancellationResponse {
  if (!isNonEmptyString(request.purchaseOrderId)) {
    invalid("purchaseOrderId", "must be a non-empty string");
  }
  if (!isNonEmptyString(request.cancellationRequestId)) {
    invalid("cancellationRequestId", "must be a non-empty string");
  }
  for (const field of ["acceptedQuantity", "rejectedQuantity"] as const) {
    const value: unknown = request[field];
    if (!Number.isInteger(value) || (value as number) < 0) {
      invalid(field, "must be an integer >= 0");
    }
  }
  if (request.acceptedQuantity + request.rejectedQuantity < 1) {
    // 수락도 거절도 없는 응답은 아무 사실도 기록하지 않는다
    invalid("acceptedQuantity", "and rejectedQuantity must not both be 0");
  }
  if (!isNonEmptyString(request.evidence)) {
    invalid("evidence", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  const repliedAtMs = parseUtcTimestamp("repliedAt", request.repliedAt, now);

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.cancellation-response",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        cancellationRequestId: request.cancellationRequestId,
        acceptedQuantity: request.acceptedQuantity,
        rejectedQuantity: request.rejectedQuantity,
        evidence: request.evidence,
        repliedAt: request.repliedAt,
      },
    },
    () => {
      const po = deps.purchaseOrders.get(request.tenantId, request.purchaseOrderId);
      // 없는 발주·타 테넌트의 발주·없는 요청·다른 발주의 요청·타 테넌트의 요청은 구별할 수 없게 같은 오류로 낸다
      const original = deps.cancellations.getRequest(
        request.tenantId,
        request.cancellationRequestId,
      );
      if (!po || !original || original.purchaseOrderId !== po.id) {
        throw new AppError("NOT_FOUND");
      }
      if (po.status !== "SENT" && po.status !== "ACKNOWLEDGED") {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "a cancellation response can only be recorded for a SENT or ACKNOWLEDGED purchase order",
        );
      }
      const line = po.lines.find((l) => l.poLineId === original.poLineId);
      if (!line) {
        throw new AppError("NOT_FOUND");
      }

      const response: CancellationResponse = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        purchaseOrderId: po.id,
        poLineId: original.poLineId,
        requestId: original.id,
        acceptedQuantity: request.acceptedQuantity,
        rejectedQuantity: request.rejectedQuantity,
        evidence: request.evidence,
        repliedAt: new Date(repliedAtMs).toISOString(),
        recordedAt: now.toISOString(),
      };

      const existing = deps.cancellations.listResponses(request.tenantId, po.id);
      // 요청량을 넘는 응답은 거절한다: 이 요청에 이미 응답한 수량과 합쳐 확인한다 (BR-P02)
      cancellationRequestState(original.quantity, [
        ...existing.filter((r) => r.requestId === original.id),
        response,
      ]);
      // 수락된 취소는 품절 확정과 합쳐 Qsend를 넘을 수 없다: 같은 수량을 두 번 차감하지 않는다 (BR-P01)
      poLineState(
        line.quantity,
        deps.replies
          .list(request.tenantId, po.id)
          .filter((r) => r.poLineId === line.poLineId),
        [...existing.filter((r) => r.poLineId === line.poLineId), response].reduce(
          (sum, r) => sum + r.acceptedQuantity,
          0,
        ),
      );

      deps.cancellations.saveResponse(response);
      return response;
    },
  );
}
