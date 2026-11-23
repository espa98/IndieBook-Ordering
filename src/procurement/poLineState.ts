import { AppError } from "../errors/AppError";

/** 공급처 회신 이벤트의 수량 효과. 이벤트는 추가 전용이라 수정하지 않는다. */
export type PoReplyEffect = {
  kind: "CONFIRM" | "OUT_OF_STOCK" | "DELAY";
  quantity: number;
  /** CONFIRM·OUT_OF_STOCK이 수량을 가져올 풀. 생략하면 미응답 (사용자 결정 1: 지연에서도 가져올 수 있다) */
  source?: "UNANSWERED" | "DELAYED";
};

/**
 * 발주 품목 하나의 수량 상태.
 * 네 풀(미응답·지연·확정·품절)의 합은 항상 Qsend다.
 */
export type PoLineState = {
  qsend: number;
  unanswered: number;
  delayed: number;
  confirmed: number;
  outOfStock: number;
  /** 공급처가 품절을 확정한 수량. 지연·미응답·고객 취소는 넣지 않는다 (BR-P01) */
  qreduce: number;
  /** 유효 발주량 = Qsend − Qreduce */
  qvalid: number;
};

/**
 * 이벤트를 순서대로 적용해 발주 품목의 수량 상태를 계산한다 (BR-P01, ST-P07).
 * 풀에 있는 수량보다 많이 가져가는 이벤트가 있으면 거절한다(수량 이중 사용 방지).
 */
export function poLineState(
  qsend: number,
  events: readonly PoReplyEffect[],
): PoLineState {
  let unanswered = qsend;
  let delayed = 0;
  let confirmed = 0;
  let outOfStock = 0;

  for (const event of events) {
    if (event.kind === "DELAY") {
      unanswered -= event.quantity;
      delayed += event.quantity;
    } else {
      if (event.source === "DELAYED") delayed -= event.quantity;
      else unanswered -= event.quantity;
      if (event.kind === "CONFIRM") confirmed += event.quantity;
      else outOfStock += event.quantity;
    }
    if (unanswered < 0 || delayed < 0) {
      throw new AppError(
        "BUSINESS_INVARIANT",
        "reply quantity exceeds the available quantity of the source pool",
      );
    }
  }

  return {
    qsend,
    unanswered,
    delayed,
    confirmed,
    outOfStock,
    qreduce: outOfStock,
    qvalid: qsend - outOfStock,
  };
}
