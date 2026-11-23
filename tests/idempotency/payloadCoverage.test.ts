/**
 * 멱등키 본문 비교의 필드 누락 방지.
 *
 * 같은 Idempotency-Key로 요청의 한 필드만 바꿔 보내면 IDEMPOTENCY_CONFLICT(409)여야 한다.
 * payload에서 필드가 빠지면 다른 요청이 이전 요청의 결과를 조용히 돌려받는다
 * (예: 품절 확정을 보냈는데 이전 '확정' 회신 결과가 반환되어 품절이 기록되지 않는다).
 *
 * 각 기능의 payload에 들어가는 모든 필드를 하나씩 바꿔 확인한다.
 */
import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";
import { createIdempotencyStore } from "../../src/idempotency/executeIdempotent";
import { addOrderLine } from "../../src/order/addOrderLine";
import { createDraftOrder } from "../../src/order/createDraftOrder";
import { confirmOrderService } from "../../src/order/confirmOrderService";
import { allocateSourcing } from "../../src/procurement/allocateSourcing";
import { createPurchaseOrder } from "../../src/procurement/createPurchaseOrder";
import { markPurchaseOrderReady } from "../../src/procurement/markPurchaseOrderReady";
import { recordPurchaseOrderDelivery } from "../../src/procurement/recordPurchaseOrderDelivery";
import { recordSupplierReply } from "../../src/procurement/recordSupplierReply";
import { createCancellationRequest } from "../../src/procurement/createCancellationRequest";
import { respondToCancellationRequest } from "../../src/procurement/respondToCancellationRequest";
import { confirmPurchaseOrderCancellation } from "../../src/procurement/confirmPurchaseOrderCancellation";
import { createInMemoryOrderRepository } from "../helpers/inMemoryOrderRepository";
import { createInMemoryExportRepository } from "../helpers/procurementFixtures";
import { sentScene, world } from "../helpers/procurementWorld";

type Fields = Record<string, unknown>;

/** base로 한 번 호출한 뒤, 같은 키로 field만 alt로 바꿔 다시 호출하면 409여야 한다. */
function expectFieldIsCompared(
  call: (request: Fields) => unknown,
  base: Fields,
  field: string,
  alt: unknown,
) {
  call(base);

  const error = thrown(() => call({ ...base, [field]: alt }));

  expect(error, `${field}를 바꿨는데 예외가 없다: 멱등 비교에서 이 필드가 빠졌다`).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
  expect((error as AppError).httpStatus).toBe(409);
}

describe("05단계 confirmOrderService: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const order = addOrderLine(createDraftOrder({ tenantId: "tenant-a" }), {
      bookId: "book-1",
      quantity: 1,
      unitPriceKrw: "1000",
    });
    const orders = createInMemoryOrderRepository([order]);
    const deps = { orders, idempotency: createIdempotencyStore(), issueDisplayNumber: () => 1 };
    const base = { tenantId: "tenant-a", orderId: order.id, expectedVersion: 1, idempotencyKey: "k-1" };
    return { call: (r: Fields) => confirmOrderService(deps, r as never), base };
  }

  it.each([
    ["orderId", "other-order"],
    ["expectedVersion", 2],
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});

describe("allocateSourcing: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const w = world();
    const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
    const base = {
      tenantId: "tenant-a",
      orderId: order.id,
      lineId: order.lines[0]!.lineId,
      supplierCode: "sup-a",
      quantity: 2,
      idempotencyKey: "k-1",
    };
    return { call: (r: Fields) => allocateSourcing(w.deps, r as never), base };
  }

  it.each([
    ["orderId", "other-order"],
    ["lineId", "other-line"],
    ["supplierCode", "sup-b"],
    ["quantity", 3],
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});

describe("createPurchaseOrder: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const w = world();
    const order = w.addOrder([{ bookId: "book-1", quantity: 5, unitPriceKrw: "1" }]);
    const a = w.allocate(order, 0, 2);
    const b = w.allocate(order, 0, 3);
    const base = { tenantId: "tenant-a", supplierCode: "sup-a", allocationIds: [a.id], idempotencyKey: "k-1" };
    return { call: (r: Fields) => createPurchaseOrder(w.deps, r as never), base, other: [b.id] };
  }

  it("supplierCode", () => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, "supplierCode", "sup-b");
  });

  it("allocationIds", () => {
    const { call, base, other } = setup();
    expectFieldIsCompared(call, base, "allocationIds", other);
  });
});

/** 같은 도서 3명(2+3+1) 합산 발주가 READY인 세계 (전달 기록 테스트용) */
function readyPurchaseOrder() {
  const w = world();
  const orders = [2, 3, 1].map((q) => w.addOrder([{ bookId: "book-1", quantity: q, unitPriceKrw: "1" }]));
  const allocations = orders.map((o, i) => w.allocate(o, 0, [2, 3, 1][i]!));
  const draft = createPurchaseOrder(w.deps, w.request(allocations.map((a) => a.id)));
  return { w, draft };
}

describe("markPurchaseOrderReady: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const { w, draft } = readyPurchaseOrder();
    const base = { tenantId: "tenant-a", purchaseOrderId: draft.id, expectedVersion: 1, idempotencyKey: "k-1" };
    return { call: (r: Fields) => markPurchaseOrderReady(w.deps, r as never), base };
  }

  it.each([
    ["purchaseOrderId", "other-po"],
    ["expectedVersion", 2],
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});

describe("recordPurchaseOrderDelivery: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const { w, draft } = readyPurchaseOrder();
    const ready = markPurchaseOrderReady(w.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: draft.id,
      expectedVersion: 1,
      idempotencyKey: "ready-1",
    });
    const deps = {
      purchaseOrders: w.deps.purchaseOrders,
      exports: createInMemoryExportRepository(),
      idempotency: w.deps.idempotency,
      now: () => new Date("2026-03-04T06:00:00.000Z"),
    };
    const base = {
      tenantId: "tenant-a",
      purchaseOrderId: ready.id,
      expectedVersion: 2,
      method: "EMAIL",
      deliveredAt: "2026-03-04T05:06:07.000Z",
      deliveredBy: "홍길동",
      referenceNumber: "MSG-123",
      idempotencyKey: "k-1",
    };
    return { call: (r: Fields) => recordPurchaseOrderDelivery(deps, r as never), base };
  }

  it.each([
    ["purchaseOrderId", "other-po"],
    ["expectedVersion", 3],
    ["method", "PHONE"],
    ["deliveredAt", "2026-03-04T05:06:08.000Z"],
    ["deliveredBy", "다른사람"],
    ["referenceNumber", "MSG-999"],
    ["fileVersion", 1], // 처음에는 없던 필드를 추가해도 다른 요청이다
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});

describe("recordSupplierReply: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const s = sentScene();
    const base = {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      poLineId: s.poLineId,
      kind: "CONFIRM",
      quantity: 2,
      evidence: "이메일 회신",
      repliedAt: "2026-03-04T05:30:00.000Z",
      idempotencyKey: "k-1",
    };
    return { call: (r: Fields) => recordSupplierReply(s.deps, r as never), base };
  }

  it.each([
    ["purchaseOrderId", "other-po"],
    ["poLineId", "other-line"],
    ["kind", "OUT_OF_STOCK"],
    ["quantity", 3],
    ["source", "UNANSWERED"], // 처음에는 생략: 같은 의미라도 다른 요청 본문이다
    ["eta", "2026-03-20"],
    ["evidence", "전화 통화 기록"],
    ["repliedAt", "2026-03-04T05:30:01.000Z"],
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});

describe("createCancellationRequest: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const s = sentScene({ secondBook: true });
    const base = {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      poLineId: s.poLineId,
      quantity: 2,
      reason: "고객 취소",
      idempotencyKey: "k-1",
    };
    return { call: (r: Fields) => createCancellationRequest(s.deps, r as never), base };
  }

  it.each([
    ["purchaseOrderId", "other-po"],
    ["poLineId", "other-line"],
    ["quantity", 3],
    ["reason", "재고 부족"],
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});

describe("respondToCancellationRequest: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const s = sentScene({ quantities: [4, 6] });
    const created = createCancellationRequest(s.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      poLineId: s.poLineId,
      quantity: 4,
      reason: "고객 취소",
      idempotencyKey: "cancel-1",
    });
    const base = {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      cancellationRequestId: created.id,
      acceptedQuantity: 1,
      rejectedQuantity: 1,
      evidence: "이메일 회신",
      repliedAt: "2026-03-04T05:30:00.000Z",
      idempotencyKey: "k-1",
    };
    return { call: (r: Fields) => respondToCancellationRequest(s.deps, r as never), base };
  }

  it.each([
    ["purchaseOrderId", "other-po"],
    ["cancellationRequestId", "other-request"],
    ["acceptedQuantity", 2],
    ["rejectedQuantity", 2],
    ["evidence", "전화 통화 기록"],
    ["repliedAt", "2026-03-04T05:30:01.000Z"],
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});

describe("confirmPurchaseOrderCancellation: 모든 필드가 멱등 비교에 들어간다", () => {
  function setup() {
    const s = sentScene();
    const asked = createCancellationRequest(s.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      poLineId: s.poLineId,
      quantity: 6,
      reason: "고객 취소",
      idempotencyKey: "ask-1",
    });
    respondToCancellationRequest(s.deps, {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      cancellationRequestId: asked.id,
      acceptedQuantity: 6,
      rejectedQuantity: 0,
      evidence: "공급처 수락",
      repliedAt: "2026-03-04T05:30:00.000Z",
      idempotencyKey: "answer-1",
    });
    const base = {
      tenantId: "tenant-a",
      purchaseOrderId: s.sent.id,
      expectedVersion: s.sent.version,
      idempotencyKey: "k-1",
    };
    return { call: (r: Fields) => confirmPurchaseOrderCancellation(s.deps, r as never), base };
  }

  it.each([
    ["purchaseOrderId", "other-po"],
    ["expectedVersion", 99],
  ])("%s", (field, alt) => {
    const { call, base } = setup();
    expectFieldIsCompared(call, base, field, alt);
  });
});
