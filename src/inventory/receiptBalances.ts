import type { ReceiptAllocation } from "./allocateReceipt";
import type { ReceiptCorrection } from "./correctReceipt";
import type { AllocationDelivery } from "./deliverAllocation";
import type { AllocationRelease } from "./releaseAllocation";
import type { GoodsReceipt } from "./receiveGoods";
import { receiptBuckets, type BucketBalances } from "./receiptBuckets";

/** 입고 기록의 정상량과 그 입고에 대한 배분·해제·인도·정정 기록으로 8버킷 잔량을 만든다. */
export function receiptBalances(
  receipt: GoodsReceipt,
  allocations: readonly ReceiptAllocation[],
  releases: readonly AllocationRelease[] = [],
  deliveries: readonly AllocationDelivery[] = [],
  corrections: readonly ReceiptCorrection[] = [],
): BucketBalances {
  return receiptBuckets(
    // 정상 순량 = 검수 등록 - 검수 정정 (BR-Q14)
    receipt.normalQuantity - corrections.reduce((sum, c) => sum + c.quantity, 0),
    [
      ...allocations.map((a) => ({
        from: "UNALLOCATED" as const,
        to: "ALLOCATED_OPEN" as const,
        quantity: a.quantity,
      })),
      ...releases.map((r) => ({
        from: "ALLOCATED_OPEN" as const,
        to: "UNALLOCATED" as const,
        quantity: r.quantity,
      })),
      ...deliveries.map((d) => ({
        from: "ALLOCATED_OPEN" as const,
        to: "DELIVERED_NET" as const,
        quantity: d.quantity,
      })),
    ],
  );
}
