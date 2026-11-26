import { describe, it, expect } from "vitest";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { addOrderLine } from "../../src/order/addOrderLine";
import { listOrders } from "../../src/order/listOrders";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { thrown } from "../helpers/thrown";
import { AppError } from "../../src/errors/AppError";

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
  it("search는 표시번호(숫자면 정확히 일치)나 품목의 도서명(부분 일치, 대소문자 무시)·ISBN(하이픈 무시, 정확히 일치)으로 주문을 찾고, 페이지네이션과 함께 동작한다", () => {
    const withLine = (id: string, createdAt: string, extra: Record<string, unknown>, bookTitle: string, bookIsbn?: string) => ({
      ...orderAt(id, createdAt),
      lines: [{ lineId: `l-${id}`, bookId: "book-1", quantity: 1, unitPriceKrw: "15000", bookTitle, ...(bookIsbn ? { bookIsbn } : {}) }],
      ...extra,
    });
    const a = withLine("id-a", "2026-01-01T00:00:00.000Z", { status: "CONFIRMED", displayNumber: 12, totalKrw: "15000" }, "독립서점 운영기", "9788960901234");
    const b = withLine("id-b", "2026-01-02T00:00:00.000Z", { status: "CONFIRMED", displayNumber: 123, totalKrw: "15000" }, "Zen and the Art", undefined);
    const c = withLine("id-c", "2026-01-03T00:00:00.000Z", {}, "책방의 오후 3시");
    const orders = createInMemoryOrderRepository([a, b, c]);
    const ids = (search: string, extra: Record<string, unknown> = {}) => listOrders({ orders }, { tenantId: "tenant-a", search, ...extra } as never).items.map((i) => i.id);

    expect(ids("12")).toEqual(["id-a"]); // 표시번호는 정확히 일치(123은 12가 아니다)
    expect(ids("123")).toEqual(["id-b"]);
    expect(ids("운영")).toEqual(["id-a"]); // 도서명 부분 일치
    expect(ids("ZEN and")).toEqual(["id-b"]); // 대소문자 무시
    expect(ids("오후")).toEqual(["id-c"]);
    expect(ids("978-8960-901234")).toEqual(["id-a"]); // ISBN은 하이픈을 무시하고 정확히 일치
    expect(ids("9788960")).toEqual([]); // ISBN 일부는 일치하지 않는다
    expect(ids("없는책")).toEqual([]);
    expect(ids("책", { status: "DRAFT" })).toEqual(["id-c"]); // 다른 필터와 함께
    expect(ids("서점")).toEqual(["id-a"]); // 도서명에 "서점"이 든 주문은 a뿐
    expect(ids("책", { limit: 1 })).toEqual(["id-c"]); // 페이지 크기와 함께
  });

  it("search가 비었거나 문자열이 아니거나 60자를 넘으면 VALIDATION_ERROR이다", () => {
    const orders = createInMemoryOrderRepository([orderAt("id-a", "2026-01-01T00:00:00.000Z")]);
    for (const bad of ["", "   ", 5, "가".repeat(61)]) {
      expect(thrown(() => listOrders({ orders }, { tenantId: "tenant-a", search: bad as never })), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("폐기된 초안은 기본적으로 목록에서 빠지고, includeDiscarded를 켜면 나온다(페이지네이션도 폐기분을 건너뛴다)", () => {
    const keep1 = orderAt("id-a", "2026-01-01T00:00:00.000Z");
    const gone = { ...orderAt("id-b", "2026-01-02T00:00:00.000Z"), discardedAt: "2026-01-02T01:00:00.000Z", discardReason: "철회", discardedBy: "u" };
    const keep2 = orderAt("id-c", "2026-01-03T00:00:00.000Z");
    const orders = createInMemoryOrderRepository([keep1, gone, keep2]);

    expect(listOrders({ orders }, { tenantId: "tenant-a" }).items.map((i) => i.id)).toEqual(["id-c", "id-a"]);
    expect(listOrders({ orders }, { tenantId: "tenant-a", includeDiscarded: true }).items.map((i) => i.id)).toEqual(["id-c", "id-b", "id-a"]);
    const first = listOrders({ orders }, { tenantId: "tenant-a", limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual(["id-c"]);
    expect(listOrders({ orders }, { tenantId: "tenant-a", limit: 1, cursor: first.nextCursor }).items.map((i) => i.id)).toEqual(["id-a"]);
    expect(() => listOrders({ orders }, { tenantId: "tenant-a", includeDiscarded: "yes" as never })).toThrow(/includeDiscarded/);
  });

  it("보류·폐기 시각을 요약에 싣는다(목록에서 보류·폐기 초안을 구별할 수 있다). 해당 없으면 필드가 없다", () => {
    const plain = orderAt("id-a", "2026-01-01T00:00:00.000Z");
    const held = { ...orderAt("id-b", "2026-01-02T00:00:00.000Z"), heldAt: "2026-01-02T01:00:00.000Z", holdReason: "확인", heldBy: "김직원" };
    const discarded = { ...orderAt("id-c", "2026-01-03T00:00:00.000Z"), discardedAt: "2026-01-03T01:00:00.000Z", discardReason: "철회", discardedBy: "이직원" };
    const page = listOrders({ orders: createInMemoryOrderRepository([plain, held, discarded]) }, { tenantId: "tenant-a", includeDiscarded: true });

    const byId = Object.fromEntries(page.items.map((i) => [i.id, i]));
    expect(byId["id-b"]).toMatchObject({ heldAt: "2026-01-02T01:00:00.000Z" });
    expect(byId["id-c"]).toMatchObject({ discardedAt: "2026-01-03T01:00:00.000Z" });
    expect("heldAt" in byId["id-a"]! || "discardedAt" in byId["id-a"]!).toBe(false);
    expect(JSON.stringify(page)).not.toMatch(/김직원|이직원|holdReason|discardReason/);
  });

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

  it("status를 지정하면 해당 상태의 주문만 반환한다 (타 테넌트 제외)", () => {
    const orders = createInMemoryOrderRepository([
      orderAt("id-a", "2026-01-01T00:00:00.000Z"),
      { ...orderAt("id-b", "2026-01-02T00:00:00.000Z"), status: "CONFIRMED" },
      orderAt("id-c", "2026-01-03T00:00:00.000Z"),
      { ...orderAt("id-d", "2026-01-04T00:00:00.000Z"), status: "CONFIRMED" },
      {
        ...draftWithLine("tenant-b"),
        id: "id-x",
        createdAt: "2026-01-05T00:00:00.000Z",
        status: "CONFIRMED",
      },
    ]);

    const confirmed = listOrders(
      { orders },
      { tenantId: "tenant-a", status: "CONFIRMED" },
    );
    const drafts = listOrders(
      { orders },
      { tenantId: "tenant-a", status: "DRAFT" },
    );

    expect(confirmed.items.map((i) => i.id)).toEqual(["id-d", "id-b"]);
    expect(drafts.items.map((i) => i.id)).toEqual(["id-c", "id-a"]);
  });

  it.each(["SHIPPED", "draft", "", null])(
    "정의되지 않은 status(%j)는 VALIDATION_ERROR로 거부한다",
    (status) => {
      const orders = createInMemoryOrderRepository([draftWithLine("tenant-a")]);

      expect(() =>
        listOrders(
          { orders },
          { tenantId: "tenant-a", status: status as unknown as "DRAFT" },
        ),
      ).toThrow(/VALIDATION_ERROR/);
    },
  );

  it("유효한 status(DRAFT, CONFIRMED)는 허용한다", () => {
    const orders = createInMemoryOrderRepository([draftWithLine("tenant-a")]);

    expect(() =>
      listOrders({ orders }, { tenantId: "tenant-a", status: "DRAFT" }),
    ).not.toThrow();
    expect(() =>
      listOrders({ orders }, { tenantId: "tenant-a", status: "CONFIRMED" }),
    ).not.toThrow();
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

  it.each([
    ["limit", { limit: 0 }],
    ["cursor", { cursor: "%%%not-base64%%%" }],
    ["status", { status: "SHIPPED" as unknown as "DRAFT" }],
  ] as const)(
    "잘못된 %s는 AppError(VALIDATION_ERROR, HTTP 400)이고 메시지에 해당 입력이 드러난다",
    (field, bad) => {
      const orders = createInMemoryOrderRepository([draftWithLine("tenant-a")]);

      const error = thrown(() =>
        listOrders({ orders }, { tenantId: "tenant-a", ...bad }),
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).message).toMatch(
        new RegExp(`^VALIDATION_ERROR: .*${field}`),
      );
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
