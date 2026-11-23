import { AppError } from "../errors/AppError";
import type { PurchaseOrderRepository } from "./createPurchaseOrder";

/** 발주 파일 출력 이력. 파일 스냅샷과 당시 발주 버전을 남긴다 (PO-004). */
export type PoExportRecord = {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  /** 출력 시점의 발주 버전 */
  poVersion: number;
  /** 발주별 출력 횟수(1부터) */
  fileVersion: number;
  format: "CSV";
  content: string;
  exportedAt: string;
};

export type PoExportRepository = {
  list(tenantId: string, purchaseOrderId: string): PoExportRecord[];
  save(record: PoExportRecord): void;
};

export type ExportPurchaseOrderCsvDeps = {
  purchaseOrders: PurchaseOrderRepository;
  exports: PoExportRepository;
  now?: () => Date;
};

export type ExportPurchaseOrderCsvRequest = {
  tenantId: string;
  purchaseOrderId: string;
};

/**
 * CSV 셀 하나를 안전하게 만든다.
 * - 수식으로 해석될 수 있는 시작 문자(= + - @ 탭 CR)는 앞에 '를 붙여 텍스트로 강제한다(CSV 주입 방어).
 * - 쉼표·큰따옴표·줄바꿈이 있으면 큰따옴표로 감싸고 내부 큰따옴표는 두 개로 만든다(RFC 4180).
 */
function csvCell(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralized)
    ? `"${neutralized.replace(/"/g, '""')}"`
    : neutralized;
}

/**
 * 공급처용 CSV를 만들고 출력 이력만 남긴다. 발주의 상태·버전은 바꾸지 않는다.
 * 파일 출력은 실제 전달이 아니다: 전달은 별도 이벤트로 기록한다 (ST-P05/ST-P06).
 */
export function exportPurchaseOrderCsv(
  deps: ExportPurchaseOrderCsvDeps,
  request: ExportPurchaseOrderCsvRequest,
): { csv: string; record: PoExportRecord } {
  const id: unknown = request.purchaseOrderId;
  if (typeof id !== "string" || id.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "purchaseOrderId must be a non-empty string");
  }
  const po = deps.purchaseOrders.get(request.tenantId, request.purchaseOrderId);
  if (!po) {
    // 없는 발주와 타 테넌트의 발주는 구별할 수 없게 같은 오류로 낸다
    throw new AppError("NOT_FOUND");
  }
  // 파일 출력은 DRAFT/READY에서만 가능하다 (ST-P05)
  if (po.status !== "DRAFT" && po.status !== "READY") {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "only a DRAFT or READY purchase order can be exported",
    );
  }
  const rows = po.lines.map(
    (line) => `${csvCell(line.bookId)},${line.quantity}`,
  );
  const csv = ["bookId,quantity", ...rows].map((r) => `${r}\r\n`).join("");
  const previous = deps.exports.list(request.tenantId, po.id);
  const record: PoExportRecord = {
    id: crypto.randomUUID(),
    tenantId: po.tenantId,
    purchaseOrderId: po.id,
    poVersion: po.version,
    fileVersion: previous.length + 1,
    format: "CSV",
    content: csv,
    exportedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  deps.exports.save(record);
  return { csv, record };
}
