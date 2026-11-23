import { describe, it, expect } from "vitest";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { exportPurchaseOrderCsv } from "../../src/procurement/exportPurchaseOrderCsv";
import { markPurchaseOrderReady } from "../../src/procurement/markPurchaseOrderReady";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { createInMemoryExportRepository } from "../helpers/procurementFixtures";
import { world } from "../helpers/procurementWorld";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 고객 3명(2+3+1권)의 같은 도서를 합산한 DRAFT 발주가 있는 세계 */
function scene() {
  const w = world();
  const orders = [2, 3, 1].map((qty) =>
    w.addOrder([{ bookId: "book-1", quantity: qty, unitPriceKrw: "15000" }]),
  );
  const allocations = orders.map((o, i) => w.allocate(o, 0, [2, 3, 1][i]!));
  const po = createPurchaseOrder(w.deps, w.request(allocations.map((a) => a.id)));
  const exports = createInMemoryExportRepository();
  const deps = {
    purchaseOrders: w.deps.purchaseOrders,
    exports,
    now: () => new Date("2026-03-04T05:06:07.000Z"),
  };
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: "tenant-a",
    purchaseOrderId: po.id,
    ...extra,
  });
  return { w, po, exports, deps, request, orders };
}

describe("exportPurchaseOrderCsv (ST-P05: 출력은 상태를 바꾸지 않고 이력만 남긴다)", () => {
  it("공급처용 CSV는 bookId,quantity만 담고(고객·주문 정보 없음), 발주는 한 글자도 바뀌지 않는다", () => {
    const { w, po, deps, request, orders } = scene();

    const result = exportPurchaseOrderCsv(deps, request());

    expect(result.csv).toBe("bookId,quantity\r\nbook-1,6\r\n"); // 2+3+1 합산
    for (const order of orders) expect(result.csv).not.toContain(order.id);
    // 인수 기준: 파일을 내려받아도 발주 상태·버전이 그대로이고 SENT로 바뀌지 않는다
    expect(w.deps.purchaseOrders.get("tenant-a", po.id)).toEqual(po);
    expect(w.deps.purchaseOrders.get("tenant-a", po.id)!.status).toBe("DRAFT");
  });

  it("출력 이력을 남기고 파일 버전이 발주별로 1씩 늘어난다", () => {
    const { po, exports, deps, request } = scene();

    const first = exportPurchaseOrderCsv(deps, request());
    const second = exportPurchaseOrderCsv(deps, request());

    expect(first.record).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      purchaseOrderId: po.id,
      poVersion: 1,
      fileVersion: 1,
      format: "CSV",
      content: first.csv, // 당시 파일 스냅샷
      exportedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(second.record.fileVersion).toBe(2);
    expect(exports.list("tenant-a", po.id).map((r) => r.fileVersion)).toEqual([1, 2]);
  });

  describe("출력할 수 없는 경우 (이력도 남기지 않는다)", () => {
    it("취소(CANCELLED)된 발주는 출력할 수 없다 → BUSINESS_INVARIANT(422)", () => {
      const { w, po, exports, deps, request } = scene();
      w.deps.purchaseOrders.save({ ...po, status: "CANCELLED" });

      const error = thrown(() => exportPurchaseOrderCsv(deps, request()));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
      expect(exports.list("tenant-a", po.id)).toHaveLength(0);
    });

    it("없는 발주와 타 테넌트의 발주는 구별할 수 없는 동일한 NOT_FOUND(404)이다", () => {
      const { po, exports, deps, request } = scene();

      const missing = thrown(() =>
        exportPurchaseOrderCsv(deps, request({ purchaseOrderId: "00000000-0000-4000-8000-000000000000" })),
      );
      const crossTenant = thrown(() => exportPurchaseOrderCsv(deps, request({ tenantId: "tenant-b" })));

      for (const error of [missing, crossTenant]) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("NOT_FOUND");
        expect((error as AppError).httpStatus).toBe(404);
      }
      expect((crossTenant as AppError).message).toBe((missing as AppError).message);
      expect(exports.list("tenant-a", po.id)).toHaveLength(0);
      expect(exports.list("tenant-b", po.id)).toHaveLength(0);
    });

    it.each(["", "   ", undefined, 7])("purchaseOrderId가 비어 있거나 문자열이 아니면(%j) 400이다", (id) => {
      const { deps, request } = scene();

      const error = thrown(() => exportPurchaseOrderCsv(deps, request({ purchaseOrderId: id }) as never));

      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(/purchaseOrderId/);
    });
  });

  describe("CSV 안전성: bookId는 클라이언트 입력이므로 수식 주입과 레코드 깨짐을 막는다", () => {
    /** 주어진 bookId 하나를 가진 발주를 출력해 데이터 행(헤더 제외)을 돌려준다 */
    function rowFor(bookId: string): string {
      const w = world();
      const order = w.addOrder([{ bookId, quantity: 1, unitPriceKrw: "1" }]);
      const allocation = w.allocate(order, 0, 1);
      const po = createPurchaseOrder(w.deps, w.request([allocation.id]));
      const { csv } = exportPurchaseOrderCsv(
        { purchaseOrders: w.deps.purchaseOrders, exports: createInMemoryExportRepository() },
        { tenantId: "tenant-a", purchaseOrderId: po.id },
      );
      return csv.slice("bookId,quantity\r\n".length);
    }

    it.each([
      ["=1+1", "'=1+1,1\r\n"],
      ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0,1\r\n"], // 큰따옴표·쉼표가 없으므로 감싸지 않는다
      ["-2+3", "'-2+3,1\r\n"],
      ["@SUM(A1)", "'@SUM(A1),1\r\n"],
      ["\t=1+1", "'\t=1+1,1\r\n"],
      ["\r=1+1", "\"'\r=1+1\",1\r\n"],
    ])("수식으로 시작하는 값(%j)은 앞에 '를 붙여 텍스트로 만든다", (bookId, expected) => {
      expect(rowFor(bookId)).toBe(expected);
    });

    it.each([
      ["a,b", "\"a,b\",1\r\n"],
      ["say \"hi\"", "\"say \"\"hi\"\"\",1\r\n"],
      ["line1\nline2", "\"line1\nline2\",1\r\n"],
      ["=a,b", "\"'=a,b\",1\r\n"], // 수식 + 쉼표: 먼저 '를 붙이고 감싼다
    ])("레코드를 깨는 값(%j)은 따옴표로 감싸고 내부 따옴표를 이중으로 만든다", (bookId, expected) => {
      expect(rowFor(bookId)).toBe(expected);
    });

    it.each(["book-1", "978-89-123-4567-8", "한글 도서", "A=B"])(
      "정상적인 값(%j)은 바뀌지 않는다 (수식 문자가 중간에 있는 것은 위험하지 않다)",
      (bookId) => {
        expect(rowFor(bookId)).toBe(`${bookId},1\r\n`);
      },
    );
  });

  it("READY 발주도 출력할 수 있고, 이력에는 그 시점의 발주 버전이 기록되며 상태는 그대로 READY다", () => {
    const { w, po, deps, request } = scene();
    const ready = markPurchaseOrderReady(w.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: po.id,
      expectedVersion: 1,
      idempotencyKey: "ready-1",
    });

    const result = exportPurchaseOrderCsv(deps, request());

    expect(result.record.poVersion).toBe(2);
    expect(w.deps.purchaseOrders.get("tenant-a", po.id)).toEqual(ready);
  });
});
