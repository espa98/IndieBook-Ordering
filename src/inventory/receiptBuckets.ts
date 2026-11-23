import { AppError } from "../errors/AppError";
import { invalid } from "../procurement/validation";

export type Bucket =
  | "UNALLOCATED"
  | "ALLOCATED_OPEN"
  | "DELIVERED_NET"
  | "DISPOSITION_PENDING"
  | "RETURN_HELD"
  | "RETURN_DISPATCHED"
  | "RETURNED_FINAL"
  | "STOCK_TRANSFERRED";

export const BUCKETS: readonly Bucket[] = [
  "UNALLOCATED",
  "ALLOCATED_OPEN",
  "DELIVERED_NET",
  "DISPOSITION_PENDING",
  "RETURN_HELD",
  "RETURN_DISPATCHED",
  "RETURNED_FINAL",
  "STOCK_TRANSFERRED",
];

/**
 * 허용된 이동. DELIVERED_NET·RETURNED_FINAL·STOCK_TRANSFERRED는 누적 귀속이라 나갈 수 없고(BR-Q17, BR-Q20),
 * 출고 중인 도서는 회수 검수 후 DISPOSITION_PENDING을 거쳐야만 다시 처분한다 (D31).
 */
const ALLOWED: Record<Bucket, readonly Bucket[]> = {
  UNALLOCATED: ["ALLOCATED_OPEN", "DISPOSITION_PENDING"],
  ALLOCATED_OPEN: ["UNALLOCATED", "DELIVERED_NET", "DISPOSITION_PENDING"],
  DELIVERED_NET: [],
  DISPOSITION_PENDING: ["RETURN_HELD", "STOCK_TRANSFERRED"],
  RETURN_HELD: ["RETURN_DISPATCHED", "DISPOSITION_PENDING"],
  RETURN_DISPATCHED: ["RETURNED_FINAL", "DISPOSITION_PENDING"],
  RETURNED_FINAL: [],
  STOCK_TRANSFERRED: [],
};

export type BucketBalances = Record<Bucket, number>;

export type BucketMove = { from: Bucket; to: Bucket; quantity: number };

/** 정상 검수 순량을 8개 버킷에 귀속한 잔량 (BR-Q14, BR-Q17). */
export function receiptBuckets(
  normalQty: number,
  moves: readonly BucketMove[],
): BucketBalances {
  if (!Number.isInteger(normalQty) || normalQty < 0) {
    invalid("normalQty", "must be an integer >= 0");
  }
  const balances: BucketBalances = {
    UNALLOCATED: normalQty,
    ALLOCATED_OPEN: 0,
    DELIVERED_NET: 0,
    DISPOSITION_PENDING: 0,
    RETURN_HELD: 0,
    RETURN_DISPATCHED: 0,
    RETURNED_FINAL: 0,
    STOCK_TRANSFERRED: 0,
  };
  for (const move of moves) {
    if (!BUCKETS.includes(move.from)) invalid("from", "must be a known bucket");
    if (!BUCKETS.includes(move.to)) invalid("to", "must be a known bucket");
    if (move.from === move.to) invalid("to", "must differ from from");
    if (!Number.isInteger(move.quantity) || move.quantity < 1) {
      invalid("quantity", "must be an integer >= 1");
    }
    if (!ALLOWED[move.from].includes(move.to)) {
      throw new AppError(
        "BUSINESS_INVARIANT",
        "this bucket transition is not allowed",
      );
    }
    balances[move.from] -= move.quantity;
    if (balances[move.from] < 0) {
      throw new AppError(
        "BUSINESS_INVARIANT",
        "bucket quantity cannot go below zero",
      );
    }
    balances[move.to] += move.quantity;
  }
  return balances;
}
