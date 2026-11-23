# BookFlow Ordering API 명세서 V2.2 — 비판적 개정본

**상태: 설계 개정 / 미배포 / 운영 배포 보류.** 기준: 실제 열람한 `API_명세서_V2.1.md`, `RLS_정책설계_V2.1.md`, 이전 OPDS V1.1 확정 정책. 기존 `/v1/` 경로는 배포 사실이 아닌 **제안**이다.

## 1. V2.1 대비 주요 수정

|ID|중요도|문제|V2.2 결정|
|---|---|---|---|
|API-01|치명|Staff가 `/orders/{id}/close` 직접 실행하도록 읽힘|`close-requests`와 내부 `execute-close` 분리. Staff는 요청, 서버가 모든 불변식 재검사 후 종결; Owner도 우회 불가|
|API-02|치명|수동 확인과 제공사 검증이 같은 `verify/post` 경로|수동 사실 확인과 자동 제공사 확인을 구분하고 provenance 및 승인·검증 규칙 별도 적용|
|API-03|치명|`refunds/confirm`에 승인 ID가 있다고 외부 환급 완료가 증명되지는 않음|실제 환급 증빙 확인과 승인 결정은 별개 조건, 둘 다 충족해야 원장 기록|
|API-04|높음|수량 N:M 상한이 API 표현에만 존재|주문·PO·로트의 복합 FK, 잠금, 원장 합계 및 롤백 검증|
|API-05|높음|Idempotency-Key 스코프·응답 저장·경쟁 상태 모호|`tenant_id + operation + key` 유일; canonical payload hash; 동일 키/다른 payload 409; 결과와 원장 동일 트랜잭션|
|API-06|높음|`If-Match`와 `expectedVersion` 이중 계약|쓰기 JSON `expectedVersion`으로 통일; 409 `VERSION_CONFLICT`; 신규 주문 생성은 제외|
|API-07|높음|공급처 미이행 수량 계산이 취소·반품·부분입고와 단순식 충돌|발주 의무와 실제 입고·수락 취소·반품/처분 별도 대사; 공급처 확인 전 의무 감소 금지|
|API-08|높음|`allocations/release` 후 타 고객 재배분 정책 미확정|재배분 자동화 보류; 기존 고객의 확보분 해제·승인 및 새 고객 확보를 별도 감사 이벤트로 기록|
|API-09|중간|증빙 JSON/URI의 임의 입력 및 개인정보 노출|allowlist 스키마, 서버 검증, 스토리지 경로·해시·보존 정책; 임의 URL 자동 호출 금지|
|API-10|중간|일괄 조회에 필드/페이지네이션 계약 부족|커서 안정 정렬 `(created_at,id)`, 최대 100, 필드별 조회 역할 제한|
|API-11|높음|승인 가능한 action과 실제 구현된 action 불일치|미구현 승인 유형은 422 `ACTION_NOT_IMPLEMENTED`; 승인 요청 생성만으로 실행 가능하다고 표시 금지|
|API-12|높음|기존 RPC의 Staff payment/complete 제한과 충돌|신규 RPC 검증 완료 전 레거시 권한 변경 금지; 버전별 라우팅/회귀 검증|

## 2. 공통 계약

- 인증: `Authorization: Bearer <Supabase access JWT>`; 테넌트 ID는 선택자일 뿐 인증 근거 아님. DB에서 `auth.uid()`와 활성 membership을 매 요청 재확인.
- 외부 공개 API: Edge Function/Backend에서 입력 검증 → 비노출 스키마의 제한된 업무 명령 RPC. 클라이언트가 `service_role`을 받지 않음.
- 상태 변경: `Idempotency-Key` 필수(요청별 유일), 기존 엔터티 변경은 `expectedVersion` 필수. **중복 재시도는 동일 저장 결과 반환**; 실패 결과 보존 정책과 만료 기간은 별도 운영 결정.
- 요청 데이터: 명시된 필드만 허용, 알 수 없는 필드는 400. 금액 `bigint`는 JSON에서 정밀도 문제를 피하도록 **10진 정수 문자열**로 전송(예: `"15000"`), 수량은 양의 정수.
- 시간: RFC3339 UTC. 원본 제공사 이벤트 시각, 서버 검증 시각, 업무 발생 시각을 구분.
- 오류: `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 IDEMPOTENCY_CONFLICT|VERSION_CONFLICT`, `422 BUSINESS_INVARIANT|EVIDENCE_INSUFFICIENT|ACTION_NOT_IMPLEMENTED`, `503 PROVIDER_UNAVAILABLE`.
- 원자성: 잠금 → 현재 권한/상태/한도 재확인 → 원장 append → audit/outbox/멱등 결과 기록 → commit. 비동기 외부 API 호출은 DB 트랜잭션 내 장시간 대기하지 않고 outbox/상태 머신으로 처리.

## 3. 엔드포인트 상세 (제안 경로)

공통 접두어: `/v1/tenants/{tenantId}`. `R`=Owner/Staff 조회, `W`=Owner/Staff 업무, `O`=Owner 전용, `S`=서버 내부.

|메서드|경로|권한|핵심 입력·검증|성공 응답|
|---|---|---|---|---|
|GET|`/orders`|R|status, cursor, limit≤100; 서점별 정렬|주문 요약 페이지|
|GET|`/orders/{orderId}`|R|서점·주문 소속, 개인정보 필드 제한|주문·품목·업무 요약|
|POST|`/orders`|W|고객 스냅샷, 품목, qty>0, unitPriceKrw 문자열|201 DRAFT, orderId|
|POST|`/orders/{id}/confirm`|W|expectedVersion, 최소 1품목, 가격 확정 규칙|CONFIRMED|
|POST|`/orders/{id}/cancel-requests`|W|lineId,qty,reason, expectedVersion|PENDING 요청|
|POST|`/purchase-orders`|W|supplierCode, lines; 주문과 발주 N:M 연결 수량|201 DRAFT|
|POST|`/purchase-orders/{id}/send`|W|expectedVersion, 공급처 전달 증빙|SENT 또는 PENDING_SEND|
|POST|`/purchase-orders/{id}/cancellation-requests`|W|poLineId,qty,reason|PENDING; 외부 수락 전 의무 유지|
|POST|`/receipts`|W|poLineId,qty,receiptRef, supplier evidence|입고 로트 및 처분 버킷|
|POST|`/allocations`|W|orderLineId,lotId,qty; 잠금·주문 미확보량·로트 가용량 검사|배분 ID|
|POST|`/allocations/{id}/release`|W/승인|qty,reason,expectedVersion; 이미 인도된 물량 제외|해제 이벤트|
|POST|`/handovers`|W|allocationId,qty; 고객 귀속 및 수령 증빙, 결제 정책|인도 원장 이벤트|
|POST|`/inventory/reservations`|W|orderLineId,bookKey,qty; 매장 재고와 고객 주문 입고 분리|예약 원장 이벤트|
|POST|`/inventory/adjustment-requests`|W|bookKey,deltaQty,reason|승인 요청|
|POST|`/payments/attempts`|W|orderId,method,amountKrw,reference,evidence|REPORTED, 원장 미반영|
|POST|`/payments/attempts/{id}/manual-review`|W(정책상)|실물/이체 증빙 출처, 금액, 참조번호, 확인자|MANUAL_REVIEWED (외부 제공사 검증 아님)|
|POST|`/payments/attempts/{id}/provider-verify`|S|제공사 서명·거래 ID·금액·수단·상태·시각 검증|PROVIDER_VERIFIED 또는 실패|
|POST|`/payments/attempts/{id}/post`|W/조건|attempt 검증 수준·중복/금액 상한 확인, 원장 1회|paymentLedgerId|
|POST|`/approvals`|W|action,entityId,reason,evidence,expectedVersion; 구현 action allowlist|PENDING|
|POST|`/approvals/{id}/decide`|O|approve,expectedVersion; 요청 잠금·업무 상태 재검증|APPROVED/REJECTED|
|POST|`/refunds/confirm`|O|approvalId, originalPaymentId, amountKrw, 실제 환급 완료 증빙|환급 원장 ID 또는 검증 실패|
|POST|`/exceptions/{id}/resolve`|W/정책|evidence,reason; 임의 waiver 비활성|RESOLVED|
|POST|`/orders/{id}/close-requests`|W|expectedVersion,reason|PENDING_CLOSE_REQUEST|
|POST|`/internal/orders/{id}/execute-close`|S|승인된 요청/정책, 동일 트랜잭션 전수 재검증|COMPLETED 또는 사유 코드|
|GET|`/audit`|O|entityId, cursor, limit; 민감정보 마스킹|감사 페이지|

**주의:** `internal` 경로는 외부 공개 라우터에 등록하지 않는다. P0는 외부 결제 사실의 **수동 기록**이므로 `provider-verify`는 P2 또는 실제 제공사 연동 이후 활성화한다.

## 4. 결제 증빙 및 환급 규칙

1. 결제 시도(REPORTED)와 수동 확인(MANUAL_REVIEWED), 제공사 검증(PROVIDER_VERIFIED), 결제 원장 반영(POSTED)은 서로 다른 사실이다. 기존 물리 스키마의 `MANUAL_VERIFIED`와 새 명칭의 매핑은 별도 마이그레이션 승인 전 **문서상 논리 상태**로만 취급한다.
2. `external_reference`만으로 실거래가 검증되었다고 판단하지 않는다. 제공사 연동 시 providerId, merchantAccount, providerTransactionId, amount, method, providerStatus, occurredAt, signature verification 결과를 대조한다.
3. P0 수동 확인: 증빙 유형·발행처·거래일·금액·주문·확인자·해시·증빙 접근 권한을 기록하고 **수동 확인 사실**로만 표시한다. 수동 확인 후 원장 반영 허용 조건은 점주가 승인한 운영 정책으로 별도 명시한다.
4. 환급은 **Owner의 내부 승인 + 외부 환급 완료 확인**을 모두 요구한다. 승인만으로 완료 처리하지 않는다. 실제 환급 요청을 생성한 시점과 완료 확인 시점을 구분한다.
5. 중복 외부 거래 ID, 원결제 누적 환급 초과, 타 서점 참조, 이미 완료된 주문에 대한 미정의 역분개는 모두 거부한다.

## 5. 종결 불변식 및 락 순서

종결 실행은 order row → order_lines → PO lines → receipt lots → allocations → payment records → exception rows 순서로 잠그고, 관련 쓰기 RPC도 같은 순서를 지켜 교착을 최소화한다. 실제 락 전략은 동시성 테스트에서 조정한다.

- `net_delivered = ordered_qty - cancelled_qty` (품목별); 취소/반품/재인도 이력은 순액으로 반영.
- `net_paid = confirmed_payment - confirmed_refund = effective_order_amount` (후불·부분결제 정책 예외가 승인되지 않았다면).
- 발주별 미이행 의무, 수락되지 않은 취소 요청, 입고 초과/차이, 공급처 반품·정산 미해결이 0.
- 로트별 모든 유효 수량이 고객 확보·인도·반품·매장 편입 등 **허용된 최종 상태**에 귀속되며 미처리 잔량 0. 고객별 배분이 주문 미인도 잔량을 넘지 않음.
- blocking OPEN 예외 0, 미결 승인/재고 정정/결제 증빙 오류 0. 고객 안내는 정책 DEC-10에 따라 일률적 필수 조건이 아님.
- 위 검사와 상태 전이는 같은 트랜잭션에서 실행; closure_check 행만으로 완료 허용 금지.

## 6. 버전 전환 및 검증 게이트

- 레거시 `ordering_v2_command`, `ordering_request_approval`, `ordering_decide_approval`, `ordering_v2_refund_confirm`는 신규 API가 준비되기 전 변경하지 않는다.
- 물리 DB V2.1 expand 파일의 누락 FK/컬럼과 본 계약을 비교해 **정합성 매트릭스**를 만든 뒤 migration 구현. 예: 기존 `ordering_orders.version` 미존재 → `expectedVersion` API 활성화 전 컬럼·동시성 구현 필수.
- 별도 Staff Auth 사용자/JWT, 교차 테넌트, 독립 세션 2개 동시 환급, 마지막 1권 동시 배분, 공급처 의무 미해결 종결 차단, 기존 19개 테스트를 모두 통과해야 한다.
