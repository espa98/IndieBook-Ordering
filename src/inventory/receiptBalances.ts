import type { ReceiptAllocation } from "./allocateReceipt";
import type { GoodsReceipt } from "./receiveGoods";
import { receiptBuckets, type BucketBalances } from "./receiptBuckets";

/** 입고 기록의 정상량과 그 입고에 대한 배분 기록으로 8버킷 잔량을 만든다. */
export function receiptBalances(
  receipt: GoodsReceipt,
  allocations: readonly ReceiptAllocation[],
): BucketBalances {
  return receiptBuckets(
    receipt.normalQuantity,
    allocations.map((a) => ({
      from: "UNALLOCATED",
      to: "ALLOCATED_OPEN",
      quantity: a.quantity,
    })),
  );
}
