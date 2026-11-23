import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import type {
  PoDelivery,
  PurchaseOrder,
  PurchaseOrderRepository,
} from "./createPurchaseOrder";
import type { PoExportRepository } from "./exportPurchaseOrderCsv";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "./validation";

export type RecordPurchaseOrderDeliveryDeps = {
  purchaseOrders: PurchaseOrderRepository;
  exports: PoExportRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type RecordPurchaseOrderDeliveryRequest = {
  tenantId: string;
  purchaseOrderId: string;
  expectedVersion: number;
  method: PoDelivery["method"];
  /** 실제 전달 시각(RFC3339 UTC). 서버 기록 시각과 구분한다. */
  deliveredAt: string;
  deliveredBy: string;
  referenceNumber?: string;
  fileVersion?: number;
  idempotencyKey: string;
};

const METHODS: readonly string[] = [
  "WEB",
  "EMAIL",
  "PHONE",
  "MESSENGER",
  "FILE",
  "API",
];

/**
 * 발주를 실제로 전달했다는 사실을 기록하고 READY → SENT로 바꾼다 (ST-P06).
 * 공급처 접수 확인(ACKNOWLEDGED)은 별도 이벤트이며 여기서 설정하지 않는다 (PO-005).
 */
export function recordPurchaseOrderDelivery(
  deps: RecordPurchaseOrderDeliveryDeps,
  request: RecordPurchaseOrderDeliveryRequest,
): PurchaseOrder {
  if (!isNonEmptyString(request.purchaseOrderId)) {
    invalid("purchaseOrderId", "must be a non-empty string");
  }
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    invalid("expectedVersion", "must be an integer >= 1");
  }
  if (!METHODS.includes(request.method)) {
    invalid("method", `must be one of ${METHODS.join(", ")}`);
  }
  const now = (deps.now ?? (() => new Date()))();
  const deliveredAtMs = parseUtcTimestamp("deliveredAt", request.deliveredAt, now);
  if (!isNonEmptyString(request.deliveredBy)) {
    invalid("deliveredBy", "must be a non-empty string");
  }
  if (
    request.referenceNumber !== undefined &&
    !isNonEmptyString(request.referenceNumber)
  ) {
    invalid("referenceNumber", "must be a non-empty string when provided");
  }
  if (
    request.fileVersion !== undefined &&
    (!Number.isInteger(request.fileVersion) || request.fileVersion < 1)
  ) {
    invalid("fileVersion", "must be an integer >= 1 when provided");
  }

  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.po-delivery",
      key: request.idempotencyKey,
      payload: {
        purchaseOrderId: request.purchaseOrderId,
        expectedVersion: request.expectedVersion,
        method: request.method,
        deliveredAt: request.deliveredAt,
        deliveredBy: request.deliveredBy,
        referenceNumber: request.referenceNumber,
        fileVersion: request.fileVersion,
      },
    },
    () => {
      const current = deps.purchaseOrders.get(
        request.tenantId,
        request.purchaseOrderId,
      );
      if (!current) {
        // 없는 발주와 타 테넌트의 발주는 구별할 수 없게 같은 오류로 낸다
        throw new AppError("NOT_FOUND");
      }
      // 이미 전달했거나(SENT) 취소된 발주, 아직 버전이 확정되지 않은(DRAFT) 발주는 전달 기록을 할 수 없다
      if (current.status !== "READY") {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "only a READY purchase order can be recorded as delivered",
        );
      }
      if (current.version !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      // 전달한 파일 버전을 밝혔다면, 이 발주의 출력 이력에 실제로 있어야 한다 (허위 근거 방지)
      if (
        request.fileVersion !== undefined &&
        !deps.exports
          .list(request.tenantId, current.id)
          .some((e) => e.fileVersion === request.fileVersion)
      ) {
        throw new AppError(
          "BUSINESS_INVARIANT",
          "fileVersion was never exported for this purchase order",
        );
      }

      const sent: PurchaseOrder = {
        ...current,
        status: "SENT",
        version: current.version + 1,
        delivery: {
          method: request.method,
          deliveredAt: new Date(deliveredAtMs).toISOString(),
          recordedAt: now.toISOString(),
          deliveredBy: request.deliveredBy,
          referenceNumber: request.referenceNumber,
          poVersion: current.version,
          fileVersion: request.fileVersion,
        },
      };
      deps.purchaseOrders.save(sent);
      return sent;
    },
  );
}
