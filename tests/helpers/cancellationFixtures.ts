import type { ApplyOrderCancellationRequest } from "../../src/order/applyOrderCancellation";
import { decideOrderCancellation } from "../../src/order/decideOrderCancellation";
import type { DecideOrderCancellationRequest } from "../../src/order/decideOrderCancellation";
import { requestOrderCancellation } from "../../src/order/requestOrderCancellation";
import type { RequestOrderCancellationRequest } from "../../src/order/requestOrderCancellation";
import { closureScene } from "./closureFixtures";

/** closureScene(주문 D 2권·예약 2, 주문 B 3권·입고 배분 3) 위에서 주문 취소 요청을 다루는 세계 */
export function cancellationRequestScene() {
  const s = closureScene();
  const { orderCancellationRequests, orderCancellationDecisions } = s.deps;
  const deps = s.deps;
  let seq = 0;
  const cancelOrderRequest = (
    extra: Partial<RequestOrderCancellationRequest> = {},
  ): RequestOrderCancellationRequest => ({
    tenantId: "tenant-a",
    orderId: s.orderD.id,
    orderLineId: s.orderD.lines[0]!.lineId,
    quantity: 1,
    reason: "고객이 1권 취소를 요청",
    expectedVersion: s.orderD.version,
    requestedBy: "김직원",
    requestedAt: "2026-03-04T06:30:00.000Z",
    idempotencyKey: `ocr-${++seq}`,
    ...extra,
  });
  return { ...s, deps, orderCancellationRequests, orderCancellationDecisions, cancelOrderRequest };
}

/** cancellationRequestScene에서 주문 D의 1권 취소 요청(REQUESTED)이 있는 세계 */
export function decisionScene() {
  const s = cancellationRequestScene();
  const cancellationRequest = requestOrderCancellation(
    s.deps,
    s.cancelOrderRequest({ quantity: 1, idempotencyKey: "ocr-scene" }),
  );
  let seq = 0;
  const decideRequest = (
    extra: Partial<DecideOrderCancellationRequest> = {},
  ): DecideOrderCancellationRequest => ({
    tenantId: "tenant-a",
    requestId: cancellationRequest.id,
    decision: "APPROVED",
    actorRole: "OWNER",
    decidedBy: "점주",
    decidedAt: "2026-03-04T06:40:00.000Z",
    idempotencyKey: `ocd-${++seq}`,
    ...extra,
  });
  return { ...s, cancellationRequest, decideRequest };
}

/** decisionScene의 요청(주문 D 1권)을 Owner가 승인한 세계 */
export function applyScene() {
  const s = decisionScene();
  decideOrderCancellation(s.deps, s.decideRequest({ decision: "APPROVED", idempotencyKey: "ocd-scene" }));
  let seq = 0;
  const applyRequest = (
    extra: Partial<ApplyOrderCancellationRequest> = {},
  ): ApplyOrderCancellationRequest => ({
    tenantId: "tenant-a",
    requestId: s.cancellationRequest.id,
    actorRole: "OWNER",
    appliedBy: "점주",
    appliedAt: "2026-03-04T06:45:00.000Z",
    idempotencyKey: `oca-${++seq}`,
    ...extra,
  });
  return { ...s, applyRequest };
}
