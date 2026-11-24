import type { Order } from "../order/createDraftOrder";
import type { PaymentConfirmation } from "./confirmPayment";
import type { Payment } from "./recordPayment";
import type { PaymentVoid } from "./voidPayment";

export type PaymentSummary = {
  totalKrw: string;
  /** 직원이 외부 증빙을 확인한 거래의 합계 (제공사 검증이 아님) */
  confirmedKrw: string;
  /** 입력됐지만 아직 확인도 무효도 되지 않은 거래의 합계 */
  pendingKrw: string;
  /** max(0, 총액 - 확인 금액) */
  balanceKrw: string;
  /** 확인 금액이 총액을 넘는 과수납분. 물량과 독립인 환급 필요 업무의 근거다 (ST-Y05) */
  refundRequiredKrw: string;
};

/** 주문의 결제 사실을 거래·확인·무효 기록에서 파생한다. 무효 거래는 합계에서 제외한다. */
export function paymentSummary(
  order: Order,
  payments: readonly Payment[],
  confirmations: readonly PaymentConfirmation[],
  voids: readonly PaymentVoid[],
): PaymentSummary {
  const total = BigInt(order.totalKrw ?? "0");
  const confirmedIds = new Set(confirmations.map((c) => c.paymentId));
  const voidedIds = new Set(voids.map((v) => v.paymentId));
  let confirmed = 0n;
  let pending = 0n;
  for (const p of payments) {
    if (voidedIds.has(p.id)) continue;
    if (confirmedIds.has(p.id)) confirmed += BigInt(p.amountKrw);
    else pending += BigInt(p.amountKrw);
  }
  const balance = total > confirmed ? total - confirmed : 0n;
  const refundRequired = confirmed > total ? confirmed - total : 0n;
  return {
    totalKrw: total.toString(),
    confirmedKrw: confirmed.toString(),
    pendingKrw: pending.toString(),
    balanceKrw: balance.toString(),
    refundRequiredKrw: refundRequired.toString(),
  };
}
