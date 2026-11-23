import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type { CancellationRepository } from "./createCancellationRequest";
import type { PurchaseOrderRepository } from "./createPurchaseOrder";
import { poLineState, type PoReplyEffect } from "./poLineState";
import {
  invalid,
  isCalendarDate,
  isNonEmptyString,
  parseUtcTimestamp,
} from "./validation";

const KINDS: readonly string[] = ["CONFIRM", "OUT_OF_STOCK", "DELAY"];
const SOURCES: readonly string[] = ["UNANSWERED", "DELAYED"];

/**
 * 공급처 회신 이벤트 (추가 전용: 수정·삭제하지 않는다).
 * 발주 본문은 바꾸지 않고 별도 기록으로 쌓는다 (ST-P07, UC-09: 원 발주 수량·이력 유지).
 */
export type PoReply = PoReplyEffect & {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  poLineId: string;
  /** 지연·확정 시 예상 입고일 */
  eta?: string;
  /** 회신의 근거(이메일 제목, 통화 기록 등) */
  evidence: string;
  /** 업무 발생 시각: 실제로 회신을 받은 시각 */
  repliedAt: string;
  /** 서버 기록 시각 */
  recordedAt: string;
};

export type PoReplyRepository = {
  list(tenantId: string, purchaseOrderId: string): PoReply[];
  save(reply: PoReply): void;
};

export type RecordSupplierReplyDeps = {
  purchaseOrders: PurchaseOrderRepository;
  replies: PoReplyRepository;
  /** 수락된 취소를 품절 확정과 합산해 Qsend를 넘지 않는지 확인하는 데 쓴다 (필수: 빠뜨리면 이중 차감 검사가 꺼진다) */
  cancellations: CancellationRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RecordSupplierReplyRequest = {
  tenantId: string;
  purchaseOrderId: string;
  poLineId: string;
  kind: PoReplyEffect["kind"];
  quantity: number;
  source?: PoReplyEffect["source"];
  eta?: string;
  evidence: string;
  repliedAt: string;
  idempotencyKey: string;
};

/**
 * 공급처의 실제 회신을 기록한다. 증빙 있는 첫 회신이 SENT를 ACKNOWLEDGED로 바꾼다
 * (사용자 결정 2). 회신이 없으면 자동으로 확인 상태가 되지 않는다.
 */
export function recordSupplierReply(
  deps: RecordSupplierReplyDeps,
  request: RecordSupplierReplyRequest,
): PoReply {
  if (!isNonEmptyString(request.purchaseOrderId)) {
    invalid("purchaseOrderId", "must be a non-empty string");
  }
  if (!isNonEmptyString(request.poLineId)) {
    invalid("poLineId", "must be a non-empty string");
  }
  if (!KINDS.includes(request.kind)) {
    invalid("kind", `must be one of ${KINDS.join(", ")}`);
  }
  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    invalid("quantity", "must be an integer >= 1");
  }
  if (request.source !== undefined && !SOURCES.includes(request.source)) {
    invalid("source", `must be one of ${SOURCES.join(", ")} when provided`);
  }
  if (request.kind === "DELAY" && request.source === "DELAYED") {
    invalid("source", "DELAY can only draw from UNANSWERED");
  }
  if (request.kind === "DELAY" && request.eta === undefined) {
    invalid("eta", "is required for DELAY");
  }
  if (request.kind === "OUT_OF_STOCK" && request.eta !== undefined) {
    // 입고 예정이 있다면 품절이 아니라 지연이다
    invalid("eta", "is not applicable to OUT_OF_STOCK (use DELAY)");
  }
  if (request.eta !== undefined && !isCalendarDate(request.eta)) {
    invalid("eta", "must be a valid YYYY-MM-DD date when provided");
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
      operation: "procurement.supplier-reply",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        poLineId: request.poLineId,
        kind: request.kind,
        quantity: request.quantity,
        source: request.source,
        eta: request.eta,
        evidence: request.evidence,
        repliedAt: request.repliedAt,
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
          "a reply can only be recorded for a SENT or ACKNOWLEDGED purchase order",
        );
      }
      const line = po.lines.find((l) => l.poLineId === request.poLineId);
      if (!line) {
        throw new AppError("NOT_FOUND");
      }

      const reply: PoReply = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        purchaseOrderId: request.purchaseOrderId,
        poLineId: request.poLineId,
        kind: request.kind,
        quantity: request.quantity,
        source: request.source,
        eta: request.eta,
        evidence: request.evidence,
        repliedAt: new Date(repliedAtMs).toISOString(),
        recordedAt: now.toISOString(),
      };
      // 저장하기 전에 이 품목의 수량 불변식을 확인한다: 위반하면 아무것도 바뀌지 않는다.
      // 수락된 취소도 함께 본다: 품절 확정 + 수락된 취소는 Qsend를 넘을 수 없다 (BR-P01).
      // 취소 회신 쪽(respondToCancellationRequest)이 같은 규칙을 확인하므로 두 순서가 대칭이다.
      poLineState(
        line.quantity,
        [
          ...deps.replies
            .list(request.tenantId, po.id)
            .filter((r) => r.poLineId === line.poLineId),
          reply,
        ],
        deps.cancellations
          .listResponses(request.tenantId, po.id)
          .filter((r) => r.poLineId === line.poLineId)
          .reduce((sum, r) => sum + r.acceptedQuantity, 0),
      );

      deps.replies.save(reply);
      if (po.status === "SENT") {
        deps.purchaseOrders.save({
          ...po,
          status: "ACKNOWLEDGED",
          version: po.version + 1,
        });
      }
      return reply;
    },
  );
}
