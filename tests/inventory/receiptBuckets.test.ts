import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { receiptBuckets } from "../../src/inventory/receiptBuckets";

import type { Bucket, BucketMove } from "../../src/inventory/receiptBuckets";

/** 순량 1권을 허용된 경로로 해당 버킷까지 옮기는 이동 목록 */
function reach(bucket: Bucket): BucketMove[] {
  const steps: Record<Bucket, [Bucket, Bucket][]> = {
    UNALLOCATED: [],
    ALLOCATED_OPEN: [["UNALLOCATED", "ALLOCATED_OPEN"]],
    DELIVERED_NET: [["UNALLOCATED", "ALLOCATED_OPEN"], ["ALLOCATED_OPEN", "DELIVERED_NET"]],
    DISPOSITION_PENDING: [["UNALLOCATED", "DISPOSITION_PENDING"]],
    RETURN_HELD: [["UNALLOCATED", "DISPOSITION_PENDING"], ["DISPOSITION_PENDING", "RETURN_HELD"]],
    RETURN_DISPATCHED: [
      ["UNALLOCATED", "DISPOSITION_PENDING"],
      ["DISPOSITION_PENDING", "RETURN_HELD"],
      ["RETURN_HELD", "RETURN_DISPATCHED"],
    ],
    RETURNED_FINAL: [
      ["UNALLOCATED", "DISPOSITION_PENDING"],
      ["DISPOSITION_PENDING", "RETURN_HELD"],
      ["RETURN_HELD", "RETURN_DISPATCHED"],
      ["RETURN_DISPATCHED", "RETURNED_FINAL"],
    ],
    STOCK_TRANSFERRED: [
      ["UNALLOCATED", "DISPOSITION_PENDING"],
      ["DISPOSITION_PENDING", "STOCK_TRANSFERRED"],
    ],
  };
  return steps[bucket].map(([from, to]) => ({ from, to, quantity: 1 }));
}

describe("receiptBuckets: 정상 검수 순량을 8개 상호배타 버킷에 귀속한다 (BR-Q14, BR-Q17)", () => {
  it("이동이 없으면 정상 검수 순량 전부가 UNALLOCATED(미배분)다", () => {
    expect(receiptBuckets(10, [])).toEqual({
      UNALLOCATED: 10,
      ALLOCATED_OPEN: 0,
      DELIVERED_NET: 0,
      DISPOSITION_PENDING: 0,
      RETURN_HELD: 0,
      RETURN_DISPATCHED: 0,
      RETURNED_FINAL: 0,
      STOCK_TRANSFERRED: 0,
    });
  });

  it("이동은 원 버킷을 줄이고 대상 버킷을 같은 양만큼 늘린다: 합계는 순량 그대로다", () => {
    const b = receiptBuckets(10, [
      { from: "UNALLOCATED", to: "ALLOCATED_OPEN", quantity: 4 },
      { from: "ALLOCATED_OPEN", to: "DELIVERED_NET", quantity: 1 },
    ]);

    expect(b).toMatchObject({ UNALLOCATED: 6, ALLOCATED_OPEN: 3, DELIVERED_NET: 1 });
    expect(Object.values(b).reduce((a, c) => a + c, 0)).toBe(10);
  });

  it("원 버킷의 잔량보다 많이 옮기면 BUSINESS_INVARIANT로 거절한다: 버킷은 음수가 될 수 없다 (BR-Q17)", () => {
    const error = thrown(() =>
      receiptBuckets(10, [
        { from: "UNALLOCATED", to: "ALLOCATED_OPEN", quantity: 4 },
        { from: "UNALLOCATED", to: "DISPOSITION_PENDING", quantity: 7 },
      ]),
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
  });

  it.each([0, -1, 1.5, Number.NaN, "2" as unknown as number])(
    "이동량이 양의 정수가 아니면(%s) VALIDATION_ERROR로 거절한다 (BR-Q22)",
    (quantity) => {
      const error = thrown(() =>
        receiptBuckets(10, [{ from: "UNALLOCATED", to: "ALLOCATED_OPEN", quantity }]),
      );

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    },
  );

  it("알 수 없는 버킷 이름(출발·도착 모두)은 VALIDATION_ERROR다: 8개 밖의 귀속을 만들 수 없다", () => {
    for (const move of [
      { from: "MISSING", to: "ALLOCATED_OPEN", quantity: 1 },
      { from: "UNALLOCATED", to: "MISSING", quantity: 1 },
    ]) {
      const error = thrown(() => receiptBuckets(10, [move as never]));
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("출발과 도착이 같은 이동은 VALIDATION_ERROR다: 근거 없는 이동 기록을 남기지 않는다", () => {
    const error = thrown(() =>
      receiptBuckets(10, [{ from: "UNALLOCATED", to: "UNALLOCATED", quantity: 1 }]),
    );

    expect((error as AppError).code).toBe("VALIDATION_ERROR");
  });

  it.each([-1, 1.5, Number.NaN, "10" as unknown as number])(
    "정상 검수 순량이 0 이상의 정수가 아니면(%s) VALIDATION_ERROR다",
    (normalQty) => {
      const error = thrown(() => receiptBuckets(normalQty, []));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    },
  );

  describe("허용된 이동만 가능하다 (BR-Q17·Q20·Q21, ST-C02~C09, D31)", () => {
    it.each([
      ["UNALLOCATED", "ALLOCATED_OPEN"],
      ["UNALLOCATED", "DISPOSITION_PENDING"],
      ["ALLOCATED_OPEN", "UNALLOCATED"],
      ["ALLOCATED_OPEN", "DELIVERED_NET"],
      ["ALLOCATED_OPEN", "DISPOSITION_PENDING"],
      ["DISPOSITION_PENDING", "RETURN_HELD"],
      ["DISPOSITION_PENDING", "STOCK_TRANSFERRED"],
      ["RETURN_HELD", "RETURN_DISPATCHED"],
      ["RETURN_HELD", "DISPOSITION_PENDING"],
      ["RETURN_DISPATCHED", "RETURNED_FINAL"],
      ["RETURN_DISPATCHED", "DISPOSITION_PENDING"],
    ] as const)("%s → %s 는 허용된다", (from, to) => {
      const setup = reach(from);

      const b = receiptBuckets(1, [...setup, { from, to, quantity: 1 }]);

      expect(b[to]).toBe(1);
    });

    it.each([
      // 종착 버킷은 누적 귀속이다: 나갈 수 없다 (BR-Q17, BR-Q20)
      ["DELIVERED_NET", "UNALLOCATED"],
      ["RETURNED_FINAL", "DISPOSITION_PENDING"],
      ["STOCK_TRANSFERRED", "DISPOSITION_PENDING"],
      // 미회수 도서는 편입할 수 없다 (D31)
      ["RETURN_DISPATCHED", "STOCK_TRANSFERRED"],
      ["RETURN_HELD", "STOCK_TRANSFERRED"],
      // 배분 없이 인도·반품·편입으로 건너뛸 수 없다
      ["UNALLOCATED", "DELIVERED_NET"],
      ["UNALLOCATED", "RETURN_HELD"],
      ["UNALLOCATED", "STOCK_TRANSFERRED"],
      ["DISPOSITION_PENDING", "RETURN_DISPATCHED"],
    ] as const)("%s → %s 는 BUSINESS_INVARIANT로 거절한다", (from, to) => {
      // 출발 버킷에 수량이 있어야 음수 검사가 아니라 전이 규칙이 거절하는지 확인된다
      const error = thrown(() =>
        receiptBuckets(1, [...reach(from), { from, to, quantity: 1 }]),
      );

      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
    });
  });
});
