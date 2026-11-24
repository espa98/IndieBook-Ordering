import type { ReceiptAllocation } from "./allocateReceipt";
import type { AllocationCancellation } from "./cancelAllocation";
import type { ReturnCompletion } from "./completeReturn";
import type { ReturnDispatch } from "./dispatchReturn";
import type { ReturnExceptionResolution } from "./resolveReturnException";
import type { ReturnReply } from "./recordReturnReply";
import type { ReturnRequest } from "./requestReturn";
import type { StockIntake } from "./transferCancelledToStock";
import type { ReceiptCorrection } from "./correctReceipt";
import type { AllocationDelivery } from "./deliverAllocation";
import type { AllocationRelease } from "./releaseAllocation";
import type { GoodsReceipt } from "./receiveGoods";
import { receiptBuckets, type BucketBalances } from "./receiptBuckets";

/** 입고 기록의 정상량과 그 입고에 대한 배분·해제·인도·정정·취소 처분·재고 편입·반품 기록으로 8버킷 잔량을 만든다. */
export function receiptBalances(
  receipt: GoodsReceipt,
  allocations: readonly ReceiptAllocation[],
  releases: readonly AllocationRelease[] = [],
  deliveries: readonly AllocationDelivery[] = [],
  corrections: readonly ReceiptCorrection[] = [],
  cancellations: readonly AllocationCancellation[] = [],
  intakes: readonly StockIntake[] = [],
  returns: {
    requests?: readonly ReturnRequest[];
    replies?: readonly ReturnReply[];
    dispatches?: readonly ReturnDispatch[];
    completions?: readonly ReturnCompletion[];
    resolutions?: readonly ReturnExceptionResolution[];
  } = {},
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
      // 주문 취소 해제는 미배분이 아니라 처분 대기로 직접 이동한다 (BR-Q21)
      ...cancellations.map((c) => ({
        from: "ALLOCATED_OPEN" as const,
        to: "DISPOSITION_PENDING" as const,
        quantity: c.quantity,
      })),
      // 편입은 처분 대기 물량을 매장 재고로 옮긴 누적 귀속이다 (BR-Q17)
      ...intakes.map((i) => ({
        from: "DISPOSITION_PENDING" as const,
        to: "STOCK_TRANSFERRED" as const,
        quantity: i.quantity,
      })),
      // 공급처 반품: 선택 -> 별도 보관, 거절 -> 처분 대기 복귀, 출고, 완료 (BR-Q17, ST-C02~C05)
      ...(returns.requests ?? []).map((r) => ({
        from: "DISPOSITION_PENDING" as const,
        to: "RETURN_HELD" as const,
        quantity: r.quantity,
      })),
      ...(returns.replies ?? [])
        .filter((r) => r.rejectedQuantity > 0)
        .map((r) => ({
          from: "RETURN_HELD" as const,
          to: "DISPOSITION_PENDING" as const,
          quantity: r.rejectedQuantity,
        })),
      ...(returns.dispatches ?? []).map((d) => ({
        from: "RETURN_HELD" as const,
        to: "RETURN_DISPATCHED" as const,
        quantity: d.quantity,
      })),
      ...(returns.completions ?? []).map((c) => ({
        from: "RETURN_DISPATCHED" as const,
        to: "RETURNED_FINAL" as const,
        quantity: c.quantity,
      })),
      // 반송·분실 예외 해소: 회수 확인은 처분 대기로 복귀, 공급처 최종 확인은 반품 완료 (ST-C09)
      ...(returns.resolutions ?? []).map((r) => ({
        from: "RETURN_DISPATCHED" as const,
        to: r.outcome === "RECOVERED" ? ("DISPOSITION_PENDING" as const) : ("RETURNED_FINAL" as const),
        quantity: r.quantity,
      })),
    ],
  );
}
