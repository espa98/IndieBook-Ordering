import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { listOrders } from "../../src/order/listOrders";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";

function draftWithLine(tenantId: string) {
  return addOrderLine(createDraftOrder({ tenantId }), {
    bookId: "book-1",
    quantity: 1,
    unitPriceKrw: "15000",
  });
}

function orderAt(id: string, createdAt: string) {
  return { ...draftWithLine("tenant-a"), id, createdAt };
}

describe("listOrders", () => {
  it("(createdAt, id) 기준 최신순으로 정렬하고 createdAt이 같으면 id 내림차순이다", () => {
    const oldest = orderAt("id-a", "2026-01-01T00:00:00.000Z");
    const tieLow = orderAt("id-b", "2026-01-02T00:00:00.000Z");
    const tieHigh = orderAt("id-c", "2026-01-02T00:00:00.000Z");
    // 저장소 반환 순서와 무관해야 하므로 일부러 뒤섞어 넣는다
    const orders = createInMemoryOrderRepository([tieLow, oldest, tieHigh]);

    const page = listOrders({ orders }, { tenantId: "tenant-a" });

    expect(page.items.map((i) => i.id)).toEqual(["id-c", "id-b", "id-a"]);
  });

  it("limit만큼만 최신 항목부터 반환한다", () => {
    const orders = createInMemoryOrderRepository([
      orderAt("id-a", "2026-01-01T00:00:00.000Z"),
      orderAt("id-b", "2026-01-02T00:00:00.000Z"),
      orderAt("id-c", "2026-01-03T00:00:00.000Z"),
    ]);

    const page = listOrders({ orders }, { tenantId: "tenant-a", limit: 2 });

    expect(page.items.map((i) => i.id)).toEqual(["id-c", "id-b"]);
  });

  it("limit을 생략하면 기본 20건만 최신순으로 반환한다", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      orderAt(
        `id-${String(i).padStart(2, "0")}`,
        `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      ),
    );
    const orders = createInMemoryOrderRepository(many);

    const page = listOrders({ orders }, { tenantId: "tenant-a" });

    expect(page.items).toHaveLength(20);
    expect(page.items[0]?.id).toBe("id-24"); // 가장 최근
    expect(page.items[19]?.id).toBe("id-05"); // 20번째
  });

  it("남은 항목이 있으면 nextCursor를 반환하고, 마지막 페이지에는 없다", () => {
    const orders = createInMemoryOrderRepository([
      orderAt("id-a", "2026-01-01T00:00:00.000Z"),
      orderAt("id-b", "2026-01-02T00:00:00.000Z"),
      orderAt("id-c", "2026-01-03T00:00:00.000Z"),
    ]);

    const more = listOrders({ orders }, { tenantId: "tenant-a", limit: 2 });
    const exact = listOrders({ orders }, { tenantId: "tenant-a", limit: 3 });

    expect(typeof more.nextCursor).toBe("string");
    expect(more.nextCursor).not.toBe("");
    expect(exact.nextCursor).toBeUndefined();
  });

  it("cursor를 넘기면 그 지점 다음부터 이어서 반환한다", () => {
    const orders = createInMemoryOrderRepository([
      orderAt("id-a", "2026-01-01T00:00:00.000Z"),
      orderAt("id-b", "2026-01-02T00:00:00.000Z"),
      orderAt("id-c", "2026-01-03T00:00:00.000Z"),
    ]);

    const first = listOrders({ orders }, { tenantId: "tenant-a", limit: 2 });
    const second = listOrders(
      { orders },
      { tenantId: "tenant-a", limit: 2, cursor: first.nextCursor },
    );

    expect(first.items.map((i) => i.id)).toEqual(["id-c", "id-b"]);
    expect(second.items.map((i) => i.id)).toEqual(["id-a"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("같은 createdAt 항목이 페이지 경계에 걸려도 끝까지 순회하면 중복·누락이 없다", () => {
    const same = "2026-01-02T00:00:00.000Z";
    const orders = createInMemoryOrderRepository([
      orderAt("id-a", "2026-01-01T00:00:00.000Z"),
      orderAt("id-b", same),
      orderAt("id-c", same),
      orderAt("id-d", same),
      orderAt("id-e", "2026-01-03T00:00:00.000Z"),
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listOrders(
        { orders },
        { tenantId: "tenant-a", limit: 2, cursor },
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(seen).toEqual(["id-e", "id-d", "id-c", "id-b", "id-a"]);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });

  it.each([
    ["깨진 base64", "%%%not-base64%%%"],
    ["JSON이 아닌 값", btoa("not json")],
    ["객체 형태", btoa(JSON.stringify({ a: 1 }))],
    ["원소가 1개인 배열", btoa(JSON.stringify(["2026-01-01T00:00:00.000Z"]))],
    ["문자열이 아닌 원소", btoa(JSON.stringify([1, 2]))],
    ["빈 문자열", ""],
  ])("잘못된 cursor(%s)는 VALIDATION_ERROR로 거부한다", (_name, cursor) => {
    const orders = createInMemoryOrderRepository([draftWithLine("tenant-a")]);

    expect(() =>
      listOrders({ orders }, { tenantId: "tenant-a", cursor }),
    ).toThrow(/VALIDATION_ERROR/);
  });

  it.each([0, -1, 1.5, Number.NaN, 101, 500])(
    "limit이 1 이상 100 이하의 정수가 아니면(%s) VALIDATION_ERROR로 거부한다",
    (limit) => {
      const orders = createInMemoryOrderRepository([draftWithLine("tenant-a")]);

      expect(() =>
        listOrders({ orders }, { tenantId: "tenant-a", limit }),
      ).toThrow(/VALIDATION_ERROR/);
    },
  );

  it("limit 경계값 1과 100은 허용한다", () => {
    const orders = createInMemoryOrderRepository([draftWithLine("tenant-a")]);

    expect(() =>
      listOrders({ orders }, { tenantId: "tenant-a", limit: 1 }),
    ).not.toThrow();
    expect(() =>
      listOrders({ orders }, { tenantId: "tenant-a", limit: 100 }),
    ).not.toThrow();
  });

  it("요청한 테넌트의 주문만 요약 필드로 반환한다", () => {
    const mine = draftWithLine("tenant-a");
    const others = draftWithLine("tenant-b");
    const orders = createInMemoryOrderRepository([mine, others]);

    const page = listOrders({ orders }, { tenantId: "tenant-a" });

    expect(page.items).toEqual([
      {
        id: mine.id,
        status: "DRAFT",
        version: 1,
        displayNumber: undefined,
        totalKrw: undefined,
      },
    ]);
  });
});
