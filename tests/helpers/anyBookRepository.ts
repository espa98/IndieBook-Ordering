import type { Book } from "../../src/catalog/registerBook";

/**
 * 시험용: 어떤 bookId도 카탈로그에 있는 것으로 본다. 도서 검증과 무관한 기존 주문 API 테스트의
 * 설정에서만 쓴다. 도서 검증 자체는 tests/order/createOrderCatalog·orderApiCatalog가 실제 저장소로 확인한다.
 */
export function createAnyBookRepository() {
  return {
    get(tenantId: string, id: string): Book {
      return {
        id,
        tenantId,
        title: `시험용 도서 ${id}`,
        authors: [],
        listPriceKrw: "1",
        source: "MANUAL",
        manualReason: "시험용",
        status: "ACTIVE",
        version: 1,
        createdBy: "test",
        createdAt: "2026-03-04T00:00:00.000Z",
        recordedAt: "2026-03-04T00:00:00.000Z",
      };
    },
  };
}
