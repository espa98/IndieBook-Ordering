import { correctFulfillment } from "../fulfillment/correctFulfillment";
import { adjustStock } from "../inventory/adjustStock";
import { cancelAllocation } from "../inventory/cancelAllocation";
import { correctReceipt } from "../inventory/correctReceipt";
import { decideExcessReceipt } from "../inventory/decideExcessReceipt";
import { reallocateAllocation } from "../inventory/reallocateAllocation";
import { registerInitialStock } from "../inventory/registerInitialStock";
import { requestReturn } from "../inventory/requestReturn";
import { resolveReceiptDefect } from "../inventory/resolveReceiptDefect";
import { transferCancelledToStock } from "../inventory/transferCancelledToStock";
import { applyOrderCancellation } from "../order/applyOrderCancellation";
import { decideOrderCancellation } from "../order/decideOrderCancellation";
import { executeOrderClosure } from "../order/executeOrderClosure";
import { executeOrderReopening } from "../order/executeOrderReopening";
import { confirmRefund } from "../payment/confirmRefund";
import { correctPayment } from "../payment/correctPayment";
import { decideRefundRequest } from "../payment/decideRefundRequest";
import { approveDuplicateRisk } from "../procurement/approveDuplicateRisk";
import { executePurchaseOrderClosure } from "../procurement/executePurchaseOrderClosure";
import { bindActor } from "./bindActor";

const BOTH = ["OWNER", "STAFF"] as const;
const OWNER = ["OWNER"] as const;
const SYSTEM = ["SYSTEM"] as const;

/**
 * 역할·행위자·테넌트를 요청 본문이 아니라 서버가 도출한 주체(Principal)에서 받는 명령 모음.
 * 외부 진입점은 도메인 함수 대신 이 모음을 호출해야 한다.
 * 키는 도메인 함수 이름이다. 새 명령이 `actorRole`·`executedBy`를 받으면 여기에 추가해야 한다(테스트가 확인한다).
 * 허용 목록이 BOTH인 명령은 도메인 함수가 역할별 세부 규칙(폐기·타 고객 재배분·철회 등)을 다시 검사한다.
 */
export const authorizedActions = {
  // Owner 전용
  correctFulfillment: bindActor(correctFulfillment, { roleField: "actorRole", nameField: "correctedBy", allow: OWNER }),
  cancelAllocation: bindActor(cancelAllocation, { roleField: "actorRole", nameField: "cancelledBy", allow: OWNER }),
  correctReceipt: bindActor(correctReceipt, { roleField: "actorRole", nameField: "correctedBy", allow: OWNER }),
  decideExcessReceipt: bindActor(decideExcessReceipt, { roleField: "actorRole", nameField: "decidedBy", allow: OWNER }),
  registerInitialStock: bindActor(registerInitialStock, { roleField: "actorRole", nameField: "actedBy", allow: OWNER }),
  requestReturn: bindActor(requestReturn, { roleField: "actorRole", nameField: "requestedBy", allow: OWNER }),
  transferCancelledToStock: bindActor(transferCancelledToStock, { roleField: "actorRole", nameField: "actedBy", allow: OWNER }),
  applyOrderCancellation: bindActor(applyOrderCancellation, { roleField: "actorRole", nameField: "appliedBy", allow: OWNER }),
  confirmRefund: bindActor(confirmRefund, { roleField: "actorRole", nameField: "confirmedBy", allow: OWNER }),
  correctPayment: bindActor(correctPayment, { roleField: "actorRole", nameField: "correctedBy", allow: OWNER }),
  approveDuplicateRisk: bindActor(approveDuplicateRisk, { roleField: "actorRole", nameField: "approvedBy", allow: OWNER }),
  // 역할별 세부 규칙이 있는 명령
  adjustStock: bindActor(adjustStock, { roleField: "actorRole", nameField: "actedBy", allow: BOTH }),
  reallocateAllocation: bindActor(reallocateAllocation, { roleField: "actorRole", nameField: "actedBy", allow: BOTH }),
  resolveReceiptDefect: bindActor(resolveReceiptDefect, { roleField: "actorRole", nameField: "resolvedBy", allow: BOTH }),
  decideOrderCancellation: bindActor(decideOrderCancellation, { roleField: "actorRole", nameField: "decidedBy", allow: BOTH }),
  decideRefundRequest: bindActor(decideRefundRequest, { roleField: "actorRole", nameField: "decidedBy", allow: BOTH }),
  // 서버 내부 업무
  executeOrderClosure: bindActor(executeOrderClosure, { systemField: "executedBy", allow: SYSTEM }),
  executeOrderReopening: bindActor(executeOrderReopening, { systemField: "executedBy", allow: SYSTEM }),
  executePurchaseOrderClosure: bindActor(executePurchaseOrderClosure, { systemField: "executedBy", allow: SYSTEM }),
} as const;
