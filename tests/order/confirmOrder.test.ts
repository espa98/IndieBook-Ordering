import { describe, it, expect, vi } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { confirmOrder } from "../../src/order/confirmOrder";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";

describe("confirmOrder (ST-O03: DRAFT → CONFIRMED)", () => {
  it("품목이 없는 초안은 확정할 수 없다", () => {
    const draft = createDraftOrder({ tenantId: "tenant-a" });

    expect(() => confirmOrder(draft, { expectedVersion: 1, issueDisplayNumber: () => 1 })).toThrow(
      /at least one line/,
    );
  });

  it("품목이 있는 초안을 확정하면 CONFIRMED가 되고 원본은 바뀌지 않는다", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });

    const confirmed = confirmOrder(draft, { expectedVersion: 1, issueDisplayNumber: () => 1 });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.id).toBe(draft.id);
    expect(draft.status).toBe("DRAFT");
  });

  it("확정하면 version이 1 증가한다 (초안의 초기 version은 1)", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });

    const confirmed = confirmOrder(draft, { expectedVersion: 1, issueDisplayNumber: () => 1 });

    expect(draft.version).toBe(1);
    expect(confirmed.version).toBe(2);
  });

  it("expectedVersion이 현재 version과 다르면 VERSION_CONFLICT로 거부한다", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });

    expect(() => confirmOrder(draft, { expectedVersion: 99, issueDisplayNumber: () => 1 })).toThrow(
      /VERSION_CONFLICT/,
    );
  });

  it("확정하면 totalKrw가 품목별 수량×단가의 합계(10진 정수 문자열)로 기록된다", () => {
    let draft = createDraftOrder({ tenantId: "tenant-a" });
    draft = addOrderLine(draft, {
      bookId: "book-1",
      quantity: 2,
      unitPriceKrw: "15000",
    });
    draft = addOrderLine(draft, {
      bookId: "book-2",
      quantity: 3,
      unitPriceKrw: "9007199254740993", // Number.MAX_SAFE_INTEGER 초과
    });

    const confirmed = confirmOrder(draft, { expectedVersion: 1, issueDisplayNumber: () => 1 });

    expect(confirmed.totalKrw).toBe("27021597764252979"); // 30000 + 27021597764222979
    expect(draft.totalKrw).toBeUndefined();
  });

  it("확정하면 서점(tenant)별 발급기에서 받은 표시번호가 기록되고 초안에는 없다 (DEC-13)", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });
    const issueDisplayNumber = vi.fn((_tenantId: string) => 42);

    const confirmed = confirmOrder(draft, {
      expectedVersion: 1,
      issueDisplayNumber,
    });

    expect(confirmed.displayNumber).toBe(42);
    expect(draft.displayNumber).toBeUndefined();
    expect(issueDisplayNumber).toHaveBeenCalledTimes(1);
    expect(issueDisplayNumber).toHaveBeenCalledWith("tenant-a");
  });

  it("이미 확정된 주문은 재확정할 수 없고 표시번호를 새로 발급하지 않는다", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });
    const confirmed = confirmOrder(draft, {
      expectedVersion: 1,
      issueDisplayNumber: () => 1,
    });
    const issueDisplayNumber = vi.fn((_tenantId: string) => 2);

    expect(() =>
      confirmOrder(confirmed, {
        expectedVersion: confirmed.version, // 버전은 일치 → 상태 때문에 거부되어야 함
        issueDisplayNumber,
      }),
    ).toThrow(/DRAFT/);
    expect(issueDisplayNumber).not.toHaveBeenCalled();
  });

  describe("오류는 올바른 code·HTTP 상태의 AppError이다", () => {
    const line = { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" };
    const issue = { issueDisplayNumber: () => 1 };
    const cases: Array<[string, () => unknown, string, number]> = [
      [
        "expectedVersion 누락",
        () =>
          (confirmOrder as (o: unknown, opts: unknown) => unknown)(
            addOrderLine(createDraftOrder({ tenantId: "t" }), line),
            issue,
          ),
        "VALIDATION_ERROR",
        400,
      ],
      [
        "버전 불일치",
        () =>
          confirmOrder(addOrderLine(createDraftOrder({ tenantId: "t" }), line), {
            expectedVersion: 99,
            ...issue,
          }),
        "VERSION_CONFLICT",
        409,
      ],
      [
        "이미 확정된 주문(DRAFT 아님)",
        () => {
          const confirmed = confirmOrder(
            addOrderLine(createDraftOrder({ tenantId: "t" }), line),
            { expectedVersion: 1, ...issue },
          );
          return confirmOrder(confirmed, {
            expectedVersion: confirmed.version,
            ...issue,
          });
        },
        "BUSINESS_INVARIANT",
        422,
      ],
      [
        "품목 없음",
        () =>
          confirmOrder(createDraftOrder({ tenantId: "t" }), {
            expectedVersion: 1,
            ...issue,
          }),
        "BUSINESS_INVARIANT",
        422,
      ],
    ];

    it.each(cases)("%s", (_name, run, code, status) => {
      const error = thrown(run);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
    });

    it("issueDisplayNumber 누락은 서버 설정 오류라 AppError가 아니다 (400으로 오해되지 않게)", () => {
      const error = thrown(() =>
        (confirmOrder as (o: unknown, opts: unknown) => unknown)(
          addOrderLine(createDraftOrder({ tenantId: "t" }), line),
          { expectedVersion: 1 },
        ),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AppError);
    });
  });

  it("issueDisplayNumber를 생략하면 거부한다 (표시번호 없이 확정 불가)", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });

    expect(() =>
      (confirmOrder as (o: typeof draft, opts: unknown) => unknown)(draft, {
        expectedVersion: 1,
      }),
    ).toThrow(/issueDisplayNumber/);
  });

  it("expectedVersion을 생략하면 거부한다 (필수 입력)", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });

    expect(() =>
      (confirmOrder as (o: typeof draft, opts?: unknown) => unknown)(draft),
    ).toThrow(/expectedVersion/);
  });
});
