import type { ReceiptDefectResolution } from "../../src/inventory/resolveReceiptDefect";

export function createInMemoryReceiptDefectResolutionRepository() {
  const all: ReceiptDefectResolution[] = [];
  return {
    list(tenantId: string, receiptId: string): ReceiptDefectResolution[] {
      return all.filter((r) => r.tenantId === tenantId && r.receiptId === receiptId);
    },
    save(resolution: ReceiptDefectResolution): void {
      all.push(resolution);
    },
  };
}
