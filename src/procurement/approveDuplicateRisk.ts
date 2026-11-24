import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { openSupplierObligations, type SupplierObligationDeps } from "./supplierObligations";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "./validation";

/**
 * 이전 공급처 의무가 남은 품목을 다른 공급처로 재조달하는 중복 구매 위험에 대한 Owner 승인 (추가 전용, BR-P05).
 * 이전 의무는 지우지 않고, 나중에 도착해 남는 물량의 처리 계획을 함께 남긴다.
 */
export type DuplicateRiskApproval = {
  id: string;
  tenantId: string;
  orderId: string;
  lineId: string;
  /** 보존되는 이전 의무의 발주와 품목 */
  purchaseOrderId: string;
  poLineId: string;
  surplusPlan: "STOCK_INTAKE" | "SUPPLIER_RETURN";
  planNote: string;
  approvedBy: string;
  approvedAt: string;
  recordedAt: string;
};

export type DuplicateRiskApprovalRepository = {
  list(tenantId: string, orderId: string): DuplicateRiskApproval[];
  save(approval: DuplicateRiskApproval): void;
};

export type ApproveDuplicateRiskDeps = {
  supplierObligations: SupplierObligationDeps;
  duplicateRiskApprovals: DuplicateRiskApprovalRepository;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type ApproveDuplicateRiskRequest = {
  tenantId: string;
  orderId: string;
  lineId: string;
  purchaseOrderId: string;
  poLineId: string;
  surplusPlan: DuplicateRiskApproval["surplusPlan"];
  planNote: string;
  actorRole: "OWNER" | "STAFF";
  approvedBy: string;
  approvedAt: string;
  idempotencyKey: string;
};

export function approveDuplicateRisk(
  deps: ApproveDuplicateRiskDeps,
  request: ApproveDuplicateRiskRequest,
): DuplicateRiskApproval {
  if (request.actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN");
  }
  if (request.surplusPlan !== "STOCK_INTAKE" && request.surplusPlan !== "SUPPLIER_RETURN") {
    invalid("surplusPlan", "must be STOCK_INTAKE or SUPPLIER_RETURN");
  }
  for (const field of ["planNote", "approvedBy"] as const) {
    if (!isNonEmptyString(request[field])) {
      invalid(field, "must be a non-empty string");
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("approvedAt", request.approvedAt, now);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "procurement.approve-duplicate-risk",
      key: request.idempotencyKey,
      payload: {
        orderId: request.orderId,
        lineId: request.lineId,
        purchaseOrderId: request.purchaseOrderId,
        poLineId: request.poLineId,
        surplusPlan: request.surplusPlan,
        planNote: request.planNote,
        approvedBy: request.approvedBy,
        approvedAt: request.approvedAt,
      },
    },
    () => {
      // 승인은 실제로 열려 있는 이전 의무에 대해서만 한다
      const open = openSupplierObligations(
        deps.supplierObligations,
        request.tenantId,
        request.orderId,
        request.lineId,
      ).some((o) => o.purchaseOrderId === request.purchaseOrderId && o.poLineId === request.poLineId);
      if (!open) {
        throw new AppError("BUSINESS_INVARIANT", "there is no open supplier obligation to approve");
      }
      const approval: DuplicateRiskApproval = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        orderId: request.orderId,
        lineId: request.lineId,
        purchaseOrderId: request.purchaseOrderId,
        poLineId: request.poLineId,
        surplusPlan: request.surplusPlan,
        planNote: request.planNote,
        approvedBy: request.approvedBy,
        approvedAt: request.approvedAt,
        recordedAt: now.toISOString(),
      };
      deps.duplicateRiskApprovals.save(approval);
      return approval;
    },
  );
}
