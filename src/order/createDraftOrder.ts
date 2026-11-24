import { AppError } from "../errors/AppError";

/** 클라이언트가 보내는 품목. lineId는 서버가 부여하므로 입력에 없다. */
export type NewOrderLine = {
  bookId: string;
  quantity: number;
  unitPriceKrw: string;
};

/** 저장되는 품목. lineId는 N:M 배분 등에서 품목을 식별한다. */
export type OrderLine = NewOrderLine & { lineId: string };

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
