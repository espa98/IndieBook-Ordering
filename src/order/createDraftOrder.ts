import { AppError } from "../errors/AppError";

/** 클라이언트가 보내는 품목. lineId는 서버가 부여하므로 입력에 없다. */
export type NewOrderLine = {
  bookId: string;
  quantity: number;
  unitPriceKrw: string;
};

/** 저장되는 품목. lineId는 N:M 배분 등에서 품목을 식별한다. */
export type OrderLine = NewOrderLine & {
  lineId: string;
  /** 주문 시점의 도서 정보 스냅샷. 카탈로그를 연결해 만든 주문에만 있다 (BOOK-007) */
  bookTitle?: string;
  bookIsbn?: string;
  listPriceKrw?: string;
};

export type Order = {
  id: string;
  tenantId: string;
  status: "DRAFT" | "CONFIRMED";
  version: number;
  createdAt: string;
  lines: OrderLine[];
  totalKrw?: string;
  displayNumber?: number;
  /** 종결 시각. 종결된 주문에는 신규 중요 거래를 추가할 수 없다 (BR-O08) */
  closedAt?: string;
  /** 전량 취소가 확정된 시각(CANCELLING). 후속 물량·금전 업무가 끝나면 종결(CANCELLED)한다 (ST-O06, BR-O07) */
  cancelledAt?: string;
  /** 보류 중인 초안의 보류 시각·사유·담당자(ST-O02). 보류는 상태 값이 아니라 이 필드로 표현한다. 재개하면 지워진다 */
  heldAt?: string;
  holdReason?: string;
  heldBy?: string;
  /** 폐기된 초안의 폐기 시각·사유·담당자(ST-O09). 상태 값이 아니라 필드로 표현하며, 이력은 보존되고 되돌릴 수 없다 */
  discardedAt?: string;
  discardReason?: string;
  discardedBy?: string;
};

export function createDraftOrder(input: {
  tenantId: string;
  now?: () => Date;
}): Order {
  if (input.tenantId.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "tenantId is required");
  }
  return {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    status: "DRAFT",
    version: 1,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    lines: [],
  };
}
