import { describe, it, expect } from "vitest";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { createInMemorySupplierRepository } from "../helpers/procurementFixtures";
import { world } from "../helpers/procurementWorld";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createPurchaseOrder (ST-P03: 없음 → DRAFT)", () => {
  it("배정 1건으로 DRAFT 발주를 만들고, 발주 품목 수량과 원 주문 품목 연결이 기록되어 저장된다", () => {
    const w = world();
    const order = w.addOrder([{ bookId: "book-1", quantity: 3, unitPriceKrw: "15000" }]);
    const allocation = w.allocate(order, 0, 2);

    const po = createPurchaseOrder(w.deps, w.request([allocation.id]));

    expect(po).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      supplierCode: "sup-a",
      status: "DRAFT",
      version: 1,
      lines: [
        {
          poLineId: expect.stringMatching(UUID_RE),
          bookId: "book-1",
          quantity: 2,
          links: [
            {
              allocationId: allocation.id,
              orderId: order.id,
              orderLineId: order.lines[0]!.lineId,
              quantity: 2,
            },
          ],
        },
      ],
    });
    expect(w.deps.purchaseOrders.get("tenant-a", po.id)).toEqual(po);
  });

  describe("배정 사전조건: 하나라도 어긋나면 발주 전체를 만들지 않는다", () => {
    function scene() {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 9, unitPriceKrw: "1" }]);
      const good = w.allocate(order, 0, 2);
      return { w, order, good };
    }

    it.each([
      ["없는 배정", "NOT_FOUND", 404],
      ["타 테넌트의 배정", "NOT_FOUND", 404],
      ["해제(RELEASED)된 배정", "BUSINESS_INVARIANT", 422],
      ["다른 공급처의 배정", "BUSINESS_INVARIANT", 422],
    ] as const)("%s가 섞이면 → %s(%i), 정상 배정도 연결되지 않고 아무것도 저장하지 않는다", (name, code, status) => {
      const { w, order, good } = scene();
      let badId = "00000000-0000-4000-8000-000000000000";
      if (name === "타 테넌트의 배정") {
        const other = { ...good, id: "11111111-1111-4111-8111-111111111111", tenantId: "tenant-b" };
        w.deps.allocations.save(other);
        badId = other.id;
      } else if (name === "해제(RELEASED)된 배정") {
        const released = w.allocate(order, 0, 1);
        w.deps.allocations.save({ ...released, status: "RELEASED" });
        badId = released.id;
      } else if (name === "다른 공급처의 배정") {
        badId = w.allocate(order, 0, 1, "sup-b").id;
      }

      const error = thrown(() => createPurchaseOrder(w.deps, w.request([good.id, badId])));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(0);
    });

    it.each([
      ["빈 목록", []],
      ["중복된 배정 ID", "DUP"],
      ["배열이 아님", "x"],
      ["원소가 문자열이 아님", [123]],
      ["원소가 빈 문자열", [""]],
    ])("allocationIds가 %s이면 400 VALIDATION_ERROR이고 저장하지 않는다", (_name, ids) => {
      const { w, good } = scene();
      const allocationIds = ids === "DUP" ? [good.id, good.id] : ids;

      const error = thrown(() =>
        createPurchaseOrder(w.deps, w.request(allocationIds as never)),
      );

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(/allocationIds/);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(0);
    });
  });

  describe("공급처 사전조건 (ST-P03: 활성 공급처)", () => {
    it.each([
      ["비활성 공급처", "BUSINESS_INVARIANT", 422],
      ["없는 공급처", "NOT_FOUND", 404],
      ["타 테넌트의 공급처", "NOT_FOUND", 404],
    ] as const)("%s → %s(%i)이고 저장하지 않는다", (name, code, status) => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const a = w.allocate(order, 0, 2, "sup-a"); // 배정 시점에는 활성이었다
      const suppliers =
        name === "비활성 공급처"
          ? createInMemorySupplierRepository([{ tenantId: "tenant-a", code: "sup-a", active: false }])
          : name === "없는 공급처"
            ? createInMemorySupplierRepository([])
            : createInMemorySupplierRepository([{ tenantId: "tenant-b", code: "sup-a", active: true }]);

      const error = thrown(() =>
        createPurchaseOrder({ ...w.deps, suppliers }, w.request([a.id])),
      );

      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(0);
    });
  });

  describe("입력 검증과 멱등키", () => {
    it.each([
      ["빈 문자열", ""],
      ["숫자", 7],
      ["누락", undefined],
    ])("supplierCode가 %s이면 400이고 저장하지 않는다", (_name, supplierCode) => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const a = w.allocate(order, 0, 2);

      const error = thrown(() =>
        createPurchaseOrder(w.deps, w.request([a.id], { supplierCode }) as never),
      );

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/supplierCode/);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(0);
    });

    it("같은 키·같은 본문의 재시도는 같은 발주를 반환하고, 연결 상한에 걸려 거절되지 않는다", () => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const a = w.allocate(order, 0, 2);
      const request = w.request([a.id], { idempotencyKey: "po-key" });

      const first = createPurchaseOrder(w.deps, request);
      const retry = createPurchaseOrder(w.deps, request); // 멱등이 아니면 이미 연결되어 422

      expect(retry).toEqual(first);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(1);
    });

    it("같은 키·다른 본문은 IDEMPOTENCY_CONFLICT(409)이고 새 발주를 만들지 않는다", () => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const a = w.allocate(order, 0, 2);
      const b = w.allocate(order, 0, 3);
      createPurchaseOrder(w.deps, w.request([a.id], { idempotencyKey: "po-key" }));

      const error = thrown(() =>
        createPurchaseOrder(w.deps, w.request([b.id], { idempotencyKey: "po-key" })),
      );

      expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((error as AppError).httpStatus).toBe(409);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(1);
    });

    it.each(["", "   ", undefined])("멱등키가 비어 있으면(%j) 400이고 저장하지 않는다", (key) => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const a = w.allocate(order, 0, 2);

      const error = thrown(() =>
        createPurchaseOrder(w.deps, w.request([a.id], { idempotencyKey: key }) as never),
      );

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toMatch(/Idempotency-Key/);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(0);
    });
  });

  describe("N:M 연결 상한: 배정 1건은 활성 발주 1개에만 연결된다 (PO-009)", () => {
    it("이미 연결된 배정을 다른 발주에 또 넣으면 BUSINESS_INVARIANT(422)이고 기존 발주는 그대로다", () => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const a = w.allocate(order, 0, 2);
      const first = createPurchaseOrder(w.deps, w.request([a.id]));

      const error = thrown(() => createPurchaseOrder(w.deps, w.request([a.id])));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(w.deps.purchaseOrders.list("tenant-a")).toEqual([first]);
    });

    it("연결된 배정과 새 배정이 섞이면 전체 거절하고, 새 배정은 연결되지 않아 나중에 따로 연결할 수 있다", () => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const linked = w.allocate(order, 0, 2);
      const fresh = w.allocate(order, 0, 3);
      createPurchaseOrder(w.deps, w.request([linked.id]));

      expect(() =>
        createPurchaseOrder(w.deps, w.request([linked.id, fresh.id])),
      ).toThrow(/BUSINESS_INVARIANT/);
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(1);

      // 새 배정은 아직 자유로우므로 단독으로는 발주할 수 있다
      expect(() => createPurchaseOrder(w.deps, w.request([fresh.id]))).not.toThrow();
      expect(w.deps.purchaseOrders.list("tenant-a")).toHaveLength(2);
    });

    it("취소(CANCELLED)된 발주의 배정은 다시 연결할 수 있다", () => {
      const w = world();
      const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
      const a = w.allocate(order, 0, 2);
      const first = createPurchaseOrder(w.deps, w.request([a.id]));
      w.deps.purchaseOrders.save({ ...first, status: "CANCELLED" }); // ST-P09로 취소된 상태

      expect(() => createPurchaseOrder(w.deps, w.request([a.id]))).not.toThrow();
    });
  });

  describe("다중 주문 합산 (PO-003)", () => {
    it("고객 3명의 같은 도서 2+3+1권을 발주 품목 하나(6권)로 합산하되, 고객별 연결 3개를 유지한다", () => {
      const w = world();
      const orders = [2, 3, 1].map((qty) =>
        w.addOrder([{ bookId: "book-1", quantity: qty, unitPriceKrw: "15000" }]),
      );
      const allocations = orders.map((o, i) => w.allocate(o, 0, [2, 3, 1][i]!));

      const po = createPurchaseOrder(w.deps, w.request(allocations.map((a) => a.id)));

      expect(po.lines).toHaveLength(1);
      expect(po.lines[0]!.bookId).toBe("book-1");
      expect(po.lines[0]!.quantity).toBe(6);
      expect(po.lines[0]!.links.map((l) => [l.orderId, l.quantity])).toEqual(
        orders.map((o, i) => [o.id, [2, 3, 1][i]]),
      );
    });

    it("다른 도서는 별도 품목이고, 도서별 합계가 정확하다", () => {
      const w = world();
      const o1 = w.addOrder([
        { bookId: "book-1", quantity: 4, unitPriceKrw: "15000" },
        { bookId: "book-2", quantity: 2, unitPriceKrw: "9000" },
      ]);
      const o2 = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "15000" }]);
      const a1 = w.allocate(o1, 0, 4); // book-1
      const a2 = w.allocate(o1, 1, 2); // book-2
      const a3 = w.allocate(o2, 0, 5); // book-1

      const po = createPurchaseOrder(w.deps, w.request([a1.id, a2.id, a3.id]));

      const byBook = Object.fromEntries(po.lines.map((l) => [l.bookId, l.quantity]));
      expect(byBook).toEqual({ "book-1": 9, "book-2": 2 });
      expect(po.lines).toHaveLength(2);
    });

    it("발주 품목 수량은 항상 연결 수량의 합이다 (불일치 불가)", () => {
      const w = world();
      const o1 = w.addOrder([{ bookId: "book-1", quantity: 3, unitPriceKrw: "1" }]);
      const o2 = w.addOrder([{ bookId: "book-1", quantity: 4, unitPriceKrw: "1" }]);
      const po = createPurchaseOrder(
        w.deps,
        w.request([w.allocate(o1, 0, 3).id, w.allocate(o2, 0, 2).id]),
      );

      for (const line of po.lines) {
        expect(line.quantity).toBe(line.links.reduce((sum, l) => sum + l.quantity, 0));
      }
    });
  });
});
