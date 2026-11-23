import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { confirmOrder } from "../../src/order/confirmOrder";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";

describe("addOrderLine", () => {
  it("초안에 품목을 추가한 새 주문을 반환하고 원본은 바꾸지 않는다", () => {
    const draft = createDraftOrder({ tenantId: "tenant-a" });

    const updated = addOrderLine(draft, {
      bookId: "book-1",
      quantity: 2,
      unitPriceKrw: "15000",
    });

    expect(updated.lines).toEqual([
      { lineId: expect.any(String), bookId: "book-1", quantity: 2, unitPriceKrw: "15000" },
    ]);
    expect(updated.id).toBe(draft.id);
    expect(draft.lines).toEqual([]);
  });

  describe("lineId (06단계 N:M 배분의 품목 식별자)", () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const input = { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" };

    it("서버가 품목마다 서로 다른 UUID lineId를 부여하고 입력 객체는 바꾸지 않는다", () => {
      const before = { ...input };
      let order = createDraftOrder({ tenantId: "t" });
      order = addOrderLine(order, input);
      order = addOrderLine(order, input); // 같은 내용의 품목도 별개의 품목이다

      expect(order.lines).toHaveLength(2);
      expect(order.lines[0]!.lineId).toMatch(UUID_RE);
      expect(order.lines[1]!.lineId).toMatch(UUID_RE);
      expect(order.lines[0]!.lineId).not.toBe(order.lines[1]!.lineId);
      expect(input).toEqual(before);
    });

    it("클라이언트가 lineId를 지정할 수 없다 (알 수 없는 필드로 400)", () => {
      const draft = createDraftOrder({ tenantId: "t" });

      const error = thrown(() =>
        addOrderLine(draft, { ...input, lineId: "chosen-by-client" } as never),
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect(draft.lines).toEqual([]);
    });

    it("확정 후에도 lineId는 그대로 유지된다", () => {
      const draft = addOrderLine(createDraftOrder({ tenantId: "t" }), input);
      const confirmed = confirmOrder(draft, {
        expectedVersion: 1,
        issueDisplayNumber: () => 1,
      });

      expect(confirmed.lines[0]!.lineId).toBe(draft.lines[0]!.lineId);
    });
  });

  it.each([
    ["누락", undefined],
    ["숫자", 123],
    ["null", null],
    ["객체", { id: 1 }],
    ["배열", ["x"]],
  ])("bookId가 문자열이 아니면(%s) 400 VALIDATION_ERROR이고 저장되지 않는다", (_name, bookId) => {
    const draft = createDraftOrder({ tenantId: "t" });
    const line = { bookId, quantity: 1, unitPriceKrw: "15000" } as never;

    const error = thrown(() => addOrderLine(draft, line));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("VALIDATION_ERROR");
    expect((error as AppError).httpStatus).toBe(400);
    expect((error as AppError).message).toMatch(/^VALIDATION_ERROR: .*bookId/);
    expect(draft.lines).toEqual([]);
  });

  it("bookId는 문자열이기만 하면 빈 문자열도 허용한다 (스펙이 길이를 제한하지 않음)", () => {
    const draft = createDraftOrder({ tenantId: "t" });

    const updated = addOrderLine(draft, { bookId: "", quantity: 1, unitPriceKrw: "1" });

    expect(updated.lines).toHaveLength(1);
  });

  it.each([
    ["isAdmin", { isAdmin: true }],
    ["note", { note: "x" }],
    ["대소문자만 다른 필드", { BookId: "x" }],
    ["__proto__ 시도", JSON.parse('{"__proto__": {"polluted": true}}')],
  ])(
    "알 수 없는 필드(%s)가 있으면 400 VALIDATION_ERROR이고 저장되지 않으며 클라이언트가 보낸 필드 이름을 메시지에 되돌리지 않는다",
    (_name, extra) => {
      const draft = createDraftOrder({ tenantId: "t" });
      const line = { bookId: "book-1", quantity: 1, unitPriceKrw: "15000", ...extra };

      const error = thrown(() => addOrderLine(draft, line));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(/unknown fields/);
      expect((error as AppError).message).not.toMatch(/isAdmin|note|BookId|polluted/);
      expect(draft.lines).toEqual([]);
    },
  );

  describe("오류는 올바른 code·HTTP 상태의 AppError이다", () => {
    const base = { bookId: "book-1", quantity: 1, unitPriceKrw: "15000" };
    const cases: Array<[string, () => unknown, string, number, RegExp]> = [
      [
        "잘못된 quantity",
        () =>
          addOrderLine(createDraftOrder({ tenantId: "t" }), { ...base, quantity: 0 }),
        "VALIDATION_ERROR",
        400,
        /^VALIDATION_ERROR: .*quantity/,
      ],
      [
        "잘못된 unitPriceKrw",
        () =>
          addOrderLine(createDraftOrder({ tenantId: "t" }), {
            ...base,
            unitPriceKrw: "15000.5",
          }),
        "VALIDATION_ERROR",
        400,
        /^VALIDATION_ERROR: .*unitPriceKrw/,
      ],
      [
        "확정된 주문에 추가(DRAFT 아님)",
        () => {
          const confirmed = confirmOrder(
            addOrderLine(createDraftOrder({ tenantId: "t" }), base),
            { expectedVersion: 1, issueDisplayNumber: () => 1 },
          );
          return addOrderLine(confirmed, base);
        },
        "BUSINESS_INVARIANT",
        422,
        /^BUSINESS_INVARIANT: .*DRAFT/,
      ],
    ];

    it.each(cases)("%s", (_name, run, code, status, message) => {
      const error = thrown(run);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
      expect((error as AppError).message).toMatch(message);
    });
  });

  it("확정된 주문에는 품목을 추가할 수 없다 (가격 스냅샷 보호)", () => {
    const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "15000",
    });
    const confirmed = confirmOrder(draft, { expectedVersion: 1, issueDisplayNumber: () => 1 });

    expect(() =>
      addOrderLine(confirmed, {
        bookId: "book-2",
        quantity: 1,
        unitPriceKrw: "1000",
      }),
    ).toThrow(/DRAFT/);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "quantity가 1 이상의 정수가 아니면(%s) 거부한다",
    (quantity) => {
      const draft = createDraftOrder({ tenantId: "tenant-a" });

      expect(() =>
        addOrderLine(draft, { bookId: "book-1", quantity, unitPriceKrw: "15000" }),
      ).toThrow(/quantity/);
    },
  );

  it.each(["15000.5", "-1", "abc", "", "015", " 100", 15000 as unknown as string])(
    "unitPriceKrw가 10진 정수 문자열이 아니면(%j) 거부한다",
    (unitPriceKrw) => {
      const draft = createDraftOrder({ tenantId: "tenant-a" });

      expect(() =>
        addOrderLine(draft, { bookId: "book-1", quantity: 1, unitPriceKrw }),
      ).toThrow(/unitPriceKrw/);
    },
  );
});
