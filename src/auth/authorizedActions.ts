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
import { getOrder } from "../order/getOrder";
import { listOrders } from "../order/listOrders";
import { applyOrderCancellation } from "../order/applyOrderCancellation";
import { decideOrderCancellation } from "../order/decideOrderCancellation";
import { executeOrderClosure } from "../order/executeOrderClosure";
import { executeOrderReopening } from "../order/executeOrderReopening";
import { confirmRefund } from "../payment/confirmRefund";
import { correctPayment } from "../payment/correctPayment";
import { decideRefundRequest } from "../payment/decideRefundRequest";
import { approveDuplicateRisk } from "../procurement/approveDuplicateRisk";
import { executePurchaseOrderClosure } from "../procurement/executePurchaseOrderClosure";
import { postFulfillment } from "../fulfillment/postFulfillment";
import { allocateReceipt } from "../inventory/allocateReceipt";
import { completeReturn } from "../inventory/completeReturn";
import { deliverAllocation } from "../inventory/deliverAllocation";
import { deliverStockReservation } from "../inventory/deliverStockReservation";
import { dispatchReturn } from "../inventory/dispatchReturn";
import { receiveGoods } from "../inventory/receiveGoods";
import { recordReturnReply } from "../inventory/recordReturnReply";
import { releaseAllocation } from "../inventory/releaseAllocation";
import { releaseStockReservation } from "../inventory/releaseStockReservation";
import { renegotiateReturn } from "../inventory/renegotiateReturn";
import { reportReturnException } from "../inventory/reportReturnException";
import { reserveStock } from "../inventory/reserveStock";
import { resolveReturnException } from "../inventory/resolveReturnException";
import { createNotificationTarget } from "../notification/createNotificationTarget";
import { recordNotificationAttempt } from "../notification/recordNotificationAttempt";
import { recordNotificationCopy } from "../notification/recordNotificationCopy";
import { recordNotificationResult } from "../notification/recordNotificationResult";
import { renotify } from "../notification/renotify";
import { requestOrderCancellation } from "../order/requestOrderCancellation";
import { requestOrderClosure } from "../order/requestOrderClosure";
import { confirmPayment } from "../payment/confirmPayment";
import { openRefundTask } from "../payment/openRefundTask";
import { recordPayment } from "../payment/recordPayment";
import { reportRefundAttempt } from "../payment/reportRefundAttempt";
import { requestRefund } from "../payment/requestRefund";
import { resolveRefundAttempt } from "../payment/resolveRefundAttempt";
import { voidPayment } from "../payment/voidPayment";
import { cancelUndeliveredPurchaseOrder } from "../procurement/cancelUndeliveredPurchaseOrder";
import { recordPurchaseOrderDelivery } from "../procurement/recordPurchaseOrderDelivery";
import { releaseSourcing } from "../procurement/releaseSourcing";
import { confirmOrderService } from "../order/confirmOrderService";
import { createOrderService } from "../order/createOrderService";
import { discardOrder } from "../order/discardOrder";
import { holdOrder } from "../order/holdOrder";
import { resumeOrder } from "../order/resumeOrder";
import { allocateSourcing } from "../procurement/allocateSourcing";
import { confirmPurchaseOrderCancellation } from "../procurement/confirmPurchaseOrderCancellation";
import { createCancellationRequest } from "../procurement/createCancellationRequest";
import { createPurchaseOrder } from "../procurement/createPurchaseOrder";
import { markPurchaseOrderReady } from "../procurement/markPurchaseOrderReady";
import { recordSupplierReply } from "../procurement/recordSupplierReply";
import { respondToCancellationRequest } from "../procurement/respondToCancellationRequest";
import { publishTemplateVersion } from "../catalog/publishTemplateVersion";
import { registerBook } from "../catalog/registerBook";
import { applyCustomerRetention } from "../customer/applyCustomerRetention";
import { anonymizeCustomer } from "../customer/anonymizeCustomer";
import { linkOrderCustomer } from "../customer/linkOrderCustomer";
import { registerCustomer } from "../customer/registerCustomer";
import { updateCustomer } from "../customer/updateCustomer";
import { registerSupplier } from "../catalog/registerSupplier";
import { setSupplierActive } from "../catalog/setSupplierActive";
import { updateSupplier } from "../catalog/updateSupplier";
import { updateBook } from "../catalog/updateBook";
import { bindActor } from "./bindActor";
import { inviteStaff } from "./inviteStaff";
import { revokeInvitation } from "./revokeInvitation";
import { setDelegation } from "./setDelegation";
import { deactivateStore } from "./deactivateStore";
import { updateStoreSettings } from "./updateStoreSettings";
import { setMembershipStatus } from "./setMembershipStatus";

const BOTH = ["OWNER", "STAFF"] as const;
const OWNER = ["OWNER"] as const;
const SYSTEM = ["SYSTEM"] as const;

/**
 * 역할·행위자·테넌트를 요청 본문이 아니라 서버가 도출한 주체(Principal)에서 받는 명령 모음.
 * 외부 진입점은 도메인 함수 대신 이 모음을 호출해야 한다.
 * 키는 도메인 함수 이름이다. 새 명령이 `actorRole`·`executedBy`나 행위자 이름 필드(`...By`)를 받으면 여기에 추가해야 한다(테스트가 확인한다).
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
  // 직원 관리(ST-A03~A05): Owner 전용
  inviteStaff: bindActor(inviteStaff, { roleField: "actorRole", nameField: "invitedBy", allow: OWNER }),
  revokeInvitation: bindActor(revokeInvitation, { roleField: "actorRole", nameField: "revokedBy", allow: OWNER }),
  setMembershipStatus: bindActor(setMembershipStatus, { roleField: "actorRole", nameField: "changedBy", allow: OWNER }),
  setDelegation: bindActor(setDelegation, { roleField: "actorRole", nameField: "changedBy", allow: OWNER }),
  updateStoreSettings: bindActor(updateStoreSettings, { roleField: "actorRole", nameField: "changedBy", allow: OWNER }),
  // 서점 중지·해지(ST-A06/A07): Owner 전용. 재사용 승인(`reactivateStore`)은 서점 구성원이 아니라 플랫폼 운영자 주체의 명령이라 여기에 없다
  deactivateStore: bindActor(deactivateStore, { roleField: "actorRole", nameField: "changedBy", allow: OWNER }),
  // 고객(C-01~04): 등록·수정은 Owner·Staff, 익명화는 Owner만(고객 결정 #10)
  applyCustomerRetention: bindActor(applyCustomerRetention, { roleField: "actorRole", nameField: "appliedBy", allow: OWNER }),
  anonymizeCustomer: bindActor(anonymizeCustomer, { roleField: "actorRole", nameField: "anonymizedBy", allow: OWNER }),
  // Owner·Staff 모두 호출하는 명령: 행위자 이름과 테넌트만 주체에서 주입한다
  postFulfillment: bindActor(postFulfillment, { nameField: "receivedBy", allow: BOTH }),
  allocateReceipt: bindActor(allocateReceipt, { nameField: "allocatedBy", allow: BOTH }),
  completeReturn: bindActor(completeReturn, { nameField: "confirmedBy", allow: BOTH }),
  deliverAllocation: bindActor(deliverAllocation, { nameField: "deliveredBy", allow: BOTH }),
  deliverStockReservation: bindActor(deliverStockReservation, { nameField: "deliveredBy", allow: BOTH }),
  dispatchReturn: bindActor(dispatchReturn, { nameField: "dispatchedBy", allow: BOTH }),
  receiveGoods: bindActor(receiveGoods, { nameField: "inspectedBy", allow: BOTH }),
  recordReturnReply: bindActor(recordReturnReply, { nameField: "repliedBy", allow: BOTH }),
  releaseAllocation: bindActor(releaseAllocation, { nameField: "releasedBy", allow: BOTH }),
  releaseStockReservation: bindActor(releaseStockReservation, { nameField: "releasedBy", allow: BOTH }),
  renegotiateReturn: bindActor(renegotiateReturn, { nameField: "requestedBy", allow: BOTH }),
  reportReturnException: bindActor(reportReturnException, { nameField: "reportedBy", allow: BOTH }),
  reserveStock: bindActor(reserveStock, { nameField: "reservedBy", allow: BOTH }),
  resolveReturnException: bindActor(resolveReturnException, { nameField: "resolvedBy", allow: BOTH }),
  createNotificationTarget: bindActor(createNotificationTarget, { nameField: "createdBy", allow: BOTH }),
  recordNotificationAttempt: bindActor(recordNotificationAttempt, { nameField: "attemptedBy", allow: BOTH }),
  recordNotificationCopy: bindActor(recordNotificationCopy, { nameField: "actedBy", allow: BOTH }),
  recordNotificationResult: bindActor(recordNotificationResult, { nameField: "recordedBy", allow: BOTH }),
  renotify: bindActor(renotify, { nameField: "createdBy", allow: BOTH }),
  requestOrderCancellation: bindActor(requestOrderCancellation, { nameField: "requestedBy", allow: BOTH }),
  requestOrderClosure: bindActor(requestOrderClosure, { nameField: "requestedBy", allow: BOTH }),
  confirmPayment: bindActor(confirmPayment, { nameField: "confirmedBy", allow: BOTH }),
  openRefundTask: bindActor(openRefundTask, { nameField: "openedBy", allow: BOTH }),
  recordPayment: bindActor(recordPayment, { nameField: "recordedBy", allow: BOTH }),
  reportRefundAttempt: bindActor(reportRefundAttempt, { nameField: "reportedBy", allow: BOTH }),
  requestRefund: bindActor(requestRefund, { nameField: "requestedBy", allow: BOTH }),
  resolveRefundAttempt: bindActor(resolveRefundAttempt, { nameField: "resolvedBy", allow: BOTH }),
  voidPayment: bindActor(voidPayment, { nameField: "voidedBy", allow: BOTH }),
  cancelUndeliveredPurchaseOrder: bindActor(cancelUndeliveredPurchaseOrder, { nameField: "cancelledBy", allow: BOTH }),
  recordPurchaseOrderDelivery: bindActor(recordPurchaseOrderDelivery, { nameField: "deliveredBy", allow: BOTH }),
  releaseSourcing: bindActor(releaseSourcing, { nameField: "releasedBy", allow: BOTH }),
  // 도서 관리(ST-B01~B03): Owner·Staff 공용
  registerBook: bindActor(registerBook, { nameField: "registeredBy", allow: BOTH }),
  updateBook: bindActor(updateBook, { nameField: "changedBy", allow: BOTH }),
  // 공급처 관리(ST-B04): Owner 또는 점주가 위임한 직원(도메인 함수가 위임을 검사한다)
  registerCustomer: bindActor(registerCustomer, { roleField: "actorRole", nameField: "registeredBy", allow: BOTH }),
  linkOrderCustomer: bindActor(linkOrderCustomer, { roleField: "actorRole", nameField: "linkedBy", allow: BOTH }),
  updateCustomer: bindActor(updateCustomer, { roleField: "actorRole", nameField: "changedBy", allow: BOTH }),
  registerSupplier: bindActor(registerSupplier, { roleField: "actorRole", nameField: "registeredBy", allow: BOTH }),
  updateSupplier: bindActor(updateSupplier, { roleField: "actorRole", nameField: "changedBy", allow: BOTH }),
  setSupplierActive: bindActor(setSupplierActive, { roleField: "actorRole", nameField: "changedBy", allow: BOTH }),
  // 안내 문구 템플릿(ST-B05): Owner 또는 위임 직원
  publishTemplateVersion: bindActor(publishTemplateVersion, { roleField: "actorRole", nameField: "publishedBy", allow: BOTH }),
  // 행위자 필드가 없는 명령: 테넌트만 주체에서 주입한다
  confirmOrderService: bindActor(confirmOrderService, { allow: BOTH }),
  createOrderService: bindActor(createOrderService, { allow: BOTH }),
  // 초안 보류·재개·폐기(ST-O02, ST-O09): Owner·Staff
  holdOrder: bindActor(holdOrder, { nameField: "heldBy", allow: BOTH }),
  resumeOrder: bindActor(resumeOrder, { nameField: "resumedBy", allow: BOTH }),
  discardOrder: bindActor(discardOrder, { nameField: "discardedBy", allow: BOTH }),
  allocateSourcing: bindActor(allocateSourcing, { allow: BOTH }),
  confirmPurchaseOrderCancellation: bindActor(confirmPurchaseOrderCancellation, { allow: BOTH }),
  createCancellationRequest: bindActor(createCancellationRequest, { allow: BOTH }),
  createPurchaseOrder: bindActor(createPurchaseOrder, { allow: BOTH }),
  markPurchaseOrderReady: bindActor(markPurchaseOrderReady, { allow: BOTH }),
  recordSupplierReply: bindActor(recordSupplierReply, { allow: BOTH }),
  respondToCancellationRequest: bindActor(respondToCancellationRequest, { allow: BOTH }),
  // 조회: 테넌트를 주체에서 주입한다
  getOrder: bindActor(getOrder, { allow: BOTH }),
  listOrders: bindActor(listOrders, { allow: BOTH }),
  // 서버 내부 업무
  executeOrderClosure: bindActor(executeOrderClosure, { systemField: "executedBy", allow: SYSTEM }),
  executeOrderReopening: bindActor(executeOrderReopening, { systemField: "executedBy", allow: SYSTEM }),
  executePurchaseOrderClosure: bindActor(executePurchaseOrderClosure, { systemField: "executedBy", allow: SYSTEM }),
} as const;
