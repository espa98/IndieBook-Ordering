import { describe, it, expect } from "vitest";
import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { AppError } from "../../src/errors/AppError";
import { addOrderLine } from "../../src/order/addOrderLine";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { thrown } from "../helpers/thrown";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import {
  confirmedOrder,
  createInMemoryAllocationRepository,
  createInMemorySupplierRepository,
} from "../helpers/procurementFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup(tenantId = "tenant-a") {
  const order = confirmedOrder(tenantId, [
    { bookId: "book-1", quantity: 3, unitPriceKrw: "15000" },
  ]);
  const orders = createInMemoryOrderRepository([order]);
  const suppliers = createInMemorySupplierRepository([
    { tenantId, code: "sup-a", active: true },
  ]);
  const allocations = createInMemoryAllocationRepository();
  const deps = {
    orders,
    suppliers,
    allocations,
    idempotency: createIdempotencyStore(),
  };
  const lineId = order.lines[0]!.lineId;
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId,
    orderId: order.id,
    lineId,
    supplierCode: "sup-a",
    quantity: 2,
    idempotencyKey: "k-1",
    ...extra,
  });
  return { deps, order, lineId, allocations, request };
}

describe("allocateSourcing (ST-P01: 없음 → ACTIVE)", () => {
  it("확정 주문의 품목에 활성 공급처로 수량을 배정하면 ACTIVE 배정이 만들어져 저장된다", () => {
    const { deps, order, lineId, allocations, request } = setup();

    const allocation = allocateSourcing(deps, request());

    expect(allocation).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      orderId: order.id,
      lineId,
      supplierCode: "sup-a",
      quantity: 2,
      status: "ACTIVE",
    });
    expect(allocations.get("tenant-a", allocation.id)).toEqual(allocation);
  });

  describe("대상이 없으면 모두 같은 NOT_FOUND(404)이다 (타 테넌트 존재 비노출)", () => {
    it("없는 주문, 타 테넌트의 주문, 주문에 속하지 않은 품목은 구별할 수 없는 동일한 오류이고 아무것도 저장하지 않는다", () => {
      const { deps, allocations, request } = setup(); // tenant-a의 주문
      const tenantBOrder = confirmedOrder("tenant-b", [
        { bookId: "book-1", quantity: 3, unitPriceKrw: "15000" },
      ]);
      deps.orders.save(tenantBOrder);

      const cases = {
        없는_주문: request({ orderId: "00000000-0000-4000-8000-000000000000" }),
        타_테넌트_주문: request({ orderId: tenantBOrder.id, lineId: tenantBOrder.lines[0]!.lineId }),
        주문에_없는_품목: request({ lineId: "00000000-0000-4000-8000-000000000000" }),
      };
      const errors = Object.values(cases).map((r) => thrown(() => allocateSourcing(deps, r)));

      for (const error of errors) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("NOT_FOUND");
        expect((error as AppError).httpStatus).toBe(404);
      }
      // 어떤 경우인지 오류만으로는 구별할 수 없다
      expect(new Set(errors.map((e) => (e as AppError).message)).size).toBe(1);
      expect(allocations.list("tenant-a")).toHaveLength(0);
      expect(allocations.list("tenant-b")).toHaveLength(0);
    });
  });

  describe("멱등키 (tenant + operation + key)", () => {
    it("같은 키·같은 본문의 재시도는 같은 배정을 반환하고, 수량이 상한에 이중으로 계산되지 않는다", () => {
      const { deps, allocations, request } = setup(); // 품목 수량 3

      const first = allocateSourcing(deps, request({ quantity: 2, idempotencyKey: "k-1" }));
      const retry = allocateSourcing(deps, request({ quantity: 2, idempotencyKey: "k-1" })); // 이중 계산하면 합계 4 > 3

      expect(retry).toEqual(first);
      expect(allocations.list("tenant-a")).toHaveLength(1);
    });

    it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이고 새 배정을 만들지 않는다", () => {
      const { deps, allocations, request } = setup();
      allocateSourcing(deps, request({ quantity: 1, idempotencyKey: "k-1" }));

      const error = thrown(() =>
        allocateSourcing(deps, request({ quantity: 2, idempotencyKey: "k-1" })),
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
      expect(allocations.list("tenant-a")).toHaveLength(1);
    });

    it.each(["", "   ", undefined])("멱등키가 비어 있으면(%j) 400이고 저장하지 않는다", (key) => {
      const { deps, allocations, request } = setup();

      const error = thrown(() =>
        allocateSourcing(deps, request({ idempotencyKey: key }) as never),
      );

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/Idempotency-Key/);
      expect(allocations.list("tenant-a")).toHaveLength(0);
    });
  });

  describe("입력 검증은 조회·상한 검사보다 먼저이고 400이다", () => {
    it.each([
      ["수량 0", { quantity: 0 }, /quantity/],
      ["수량 음수", { quantity: -1 }, /quantity/],
      ["수량 소수", { quantity: 1.5 }, /quantity/],
      ["수량 NaN", { quantity: Number.NaN }, /quantity/],
      ["수량 문자열", { quantity: "2" }, /quantity/],
      ["수량 null", { quantity: null }, /quantity/],
      ["수량 누락", { quantity: undefined }, /quantity/],
      ["supplierCode 빈 문자열", { supplierCode: "" }, /supplierCode/],
      ["supplierCode 숫자", { supplierCode: 7 }, /supplierCode/],
      ["orderId 누락", { orderId: undefined }, /orderId/],
      ["lineId 빈 문자열", { lineId: "  " }, /lineId/],
    ])("%s → 400 VALIDATION_ERROR, 저장하지 않음", (_name, bad, field) => {
      const { deps, allocations, request } = setup();

      const error = thrown(() => allocateSourcing(deps, request(bad) as never));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(field);
      expect(allocations.list("tenant-a")).toHaveLength(0);
    });
  });

  describe("사전조건: 확정 주문, 활성 공급처 (UC-07/08)", () => {
    function setupFor(extra: {
      order?: ReturnType<typeof confirmedOrder>;
      suppliers?: Array<{ tenantId: string; code: string; active: boolean }>;
    }) {
      const order =
        extra.order ??
        confirmedOrder("tenant-a", [{ bookId: "book-1", quantity: 3, unitPriceKrw: "15000" }]);
      const allocations = createInMemoryAllocationRepository();
      const deps = {
        orders: createInMemoryOrderRepository([order]),
        suppliers: createInMemorySupplierRepository(
          extra.suppliers ?? [{ tenantId: "tenant-a", code: "sup-a", active: true }],
        ),
        allocations,
        idempotency: createIdempotencyStore(),
      };
      const request = {
        tenantId: "tenant-a",
        orderId: order.id,
        lineId: order.lines[0]!.lineId,
        supplierCode: "sup-a",
        quantity: 1,
        idempotencyKey: "k-1",
      };
      return { deps, allocations, request };
    }

    it.each([
      ["초안(DRAFT) 주문", "BUSINESS_INVARIANT", 422],
      ["비활성 공급처", "BUSINESS_INVARIANT", 422],
      ["없는 공급처", "NOT_FOUND", 404],
      ["타 테넌트의 공급처", "NOT_FOUND", 404],
    ] as const)("%s → %s(%i)이고 저장하지 않는다", (name, code, status) => {
      const draft = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
        bookId: "book-1",
        quantity: 3,
        unitPriceKrw: "15000",
      });
      const { deps, allocations, request } =
        name === "초안(DRAFT) 주문"
          ? setupFor({ order: draft })
          : name === "비활성 공급처"
            ? setupFor({ suppliers: [{ tenantId: "tenant-a", code: "sup-a", active: false }] })
            : name === "없는 공급처"
              ? setupFor({ suppliers: [] })
              : setupFor({ suppliers: [{ tenantId: "tenant-b", code: "sup-a", active: true }] });

      const error = thrown(() => allocateSourcing(deps, request));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
      expect(allocations.list("tenant-a")).toHaveLength(0);
    });
  });

  describe("합계 상한: 한 주문 품목의 활성 배정 합계 ≤ 주문 품목 수량 (PO-009)", () => {
    it("합계가 품목 수량을 넘는 배정은 BUSINESS_INVARIANT(422)로 거절하고 저장하지 않는다", () => {
      const { deps, allocations, request } = setup(); // 품목 수량 3
      allocateSourcing(deps, request({ quantity: 2, idempotencyKey: "k-1" }));

      const error = thrown(() =>
        allocateSourcing(deps, request({ quantity: 2, idempotencyKey: "k-2" })), // 합계 4
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(allocations.list("tenant-a")).toHaveLength(1);
    });

    it("합계가 정확히 품목 수량과 같으면 허용한다 (경계값)", () => {
      const { deps, allocations, request } = setup();

      allocateSourcing(deps, request({ quantity: 2, idempotencyKey: "k-1" }));
      allocateSourcing(deps, request({ quantity: 1, idempotencyKey: "k-2" })); // 합계 3

      expect(allocations.list("tenant-a")).toHaveLength(2);
    });

    it("다른 공급처로 나눠도 같은 품목의 합계가 기준이다 (A 2권 + B 1권은 허용, +1권은 거절)", () => {
      const { deps, request } = setup();
      const suppliers = createInMemorySupplierRepository([
        { tenantId: "tenant-a", code: "sup-a", active: true },
        { tenantId: "tenant-a", code: "sup-b", active: true },
      ]);
      const both = { ...deps, suppliers };

      allocateSourcing(both, request({ supplierCode: "sup-a", quantity: 2, idempotencyKey: "k-1" }));
      allocateSourcing(both, request({ supplierCode: "sup-b", quantity: 1, idempotencyKey: "k-2" }));

      expect(() =>
        allocateSourcing(both, request({ supplierCode: "sup-b", quantity: 1, idempotencyKey: "k-3" })),
      ).toThrow(/BUSINESS_INVARIANT/);
    });

    it("상한은 품목별이다: 한 품목이 가득 차도 같은 주문의 다른 품목은 배정할 수 있다", () => {
      const order = confirmedOrder("tenant-a", [
        { bookId: "book-1", quantity: 3, unitPriceKrw: "15000" },
        { bookId: "book-2", quantity: 5, unitPriceKrw: "9000" },
      ]);
      const deps = {
        orders: createInMemoryOrderRepository([order]),
        suppliers: createInMemorySupplierRepository([
          { tenantId: "tenant-a", code: "sup-a", active: true },
        ]),
        allocations: createInMemoryAllocationRepository(),
        idempotency: createIdempotencyStore(),
      };
      const [line1, line2] = order.lines;
      const base = { tenantId: "tenant-a", orderId: order.id, supplierCode: "sup-a" };

      allocateSourcing(deps, { ...base, lineId: line1!.lineId, quantity: 3, idempotencyKey: "k-1" });
      // 품목 2는 자신의 수량(5)까지 배정할 수 있다: 품목 1의 배정이 영향을 주지 않는다
      expect(() =>
        allocateSourcing(deps, { ...base, lineId: line2!.lineId, quantity: 5, idempotencyKey: "k-2" }),
      ).not.toThrow();
      // 반대로 품목 2의 상한(5)은 품목 2 기준으로 적용된다
      expect(() =>
        allocateSourcing(deps, { ...base, lineId: line2!.lineId, quantity: 1, idempotencyKey: "k-3" }),
      ).toThrow(/BUSINESS_INVARIANT/);
    });

    it("RELEASED된 배정은 합계에서 빠진다", () => {
      const { deps, allocations, request } = setup();
      const first = allocateSourcing(deps, request({ quantity: 3, idempotencyKey: "k-1" }));
      allocations.save({ ...first, status: "RELEASED" }); // ST-P02로 해제된 상태

      expect(() =>
        allocateSourcing(deps, request({ quantity: 3, idempotencyKey: "k-2" })),
      ).not.toThrow();
    });
  });
});
