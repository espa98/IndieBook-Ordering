import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { confirmRefund, type ConfirmRefundDeps, type RefundConfirmation } from "./confirmRefund";
import {
  refundRequestStatus,
  type RefundRequestDecision,
  type RefundRequestDecisionRepository,
  type RefundRequestRepository,
} from "./requestRefund";

export type DecideRefundRequestDeps = ConfirmRefundDeps & {
  refundRequests: RefundRequestRepository;
  refundRequestDecisions: RefundRequestDecisionRepository;
  idempotency: IdempotencyStore;
};

export type DecideRefundRequestRequest = {
  tenantId: string;
  requestId: string;
  decision: "APPROVED" | "REJECTED" | "WITHDRAWN";
  actorRole: "OWNER" | "STAFF";
  decidedBy: string;
  decidedAt: string;
  idempotencyKey: string;
};

export type DecideRefundRequestResult = {
  decision: RefundRequestDecision;
  /** 승인일 때만: 같은 호출에서 기록된 환급 원장 */
  refund?: RefundConfirmation;
};

export function decideRefundRequest(
  deps: DecideRefundRequestDeps,
  request: DecideRefundRequestRequest,
): DecideRefundRequestResult {
  if (
    request.decision !== "APPROVED" &&
    request.decision !== "REJECTED" &&
    request.decision !== "WITHDRAWN"
  ) {
    invalid("decision", "must be APPROVED, REJECTED or WITHDRAWN");
  }
  if (!isNonEmptyString(request.decidedBy)) {
    invalid("decidedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("decidedAt", request.decidedAt, now);
  // 승인·거절은 Owner 업무다(DEC-09). 철회는 Staff도 할 수 있다
  if (request.decision !== "WITHDRAWN" && request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  const refundRequest = deps.refundRequests.get(request.tenantId, request.requestId);
  if (!refundRequest) {
    throw new AppError("NOT_FOUND");
  }
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "payment.decide-refund-request",
      key: request.idempotencyKey,
      payload: {
        requestId: request.requestId,
        decision: request.decision,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt,
      },
    },
    () => {
      // 결정은 REQUESTED 상태에서 한 번만 할 수 있다 (두 세션이 같은 요청을 승인해도 원장은 한 번)
      if (
        refundRequestStatus(deps.refundRequestDecisions.list(request.tenantId, refundRequest.id)) !==
        "REQUESTED"
      ) {
        throw new AppError("BUSINESS_INVARIANT", "the refund request is already decided");
      }
      // 승인일 때만 환급 원장을 기록한다. 원장 검증이 실패하면 결정도 기록하지 않는다 (원자 처리)
      const refund =
        request.decision !== "APPROVED"
          ? undefined
          : confirmRefund(deps, {
            tenantId: request.tenantId,
            refundTaskId: refundRequest.refundTaskId,
            paymentId: refundRequest.paymentId,
            amountKrw: refundRequest.amountKrw,
            evidence: refundRequest.evidence,
            actorRole: request.actorRole,
            confirmedBy: request.decidedBy,
            confirmedAt: request.decidedAt,
            refundRequestId: refundRequest.id,
            idempotencyKey: `${request.idempotencyKey}:ledger`,
          });
      const decision: RefundRequestDecision = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        requestId: refundRequest.id,
        kind: request.decision,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt,
        recordedAt: now.toISOString(),
      };
      deps.refundRequestDecisions.save(decision);
      return refund === undefined ? { decision } : { decision, refund };
    },
  );
}
