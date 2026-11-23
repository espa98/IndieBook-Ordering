# BookFlow Ordering API 명세서 V2.1 (설계안)

상태: **미배포 / 운영 배포 보류**. 기준: ERD V2.1, 물리 DB expand 패키지, OPDS V1.1. 아래 `/v1/...`은 **제안하는 Edge Function/Backend 경로**이지 현재 배포된 API가 아니다. 기존 `ordering_v2_command`, `ordering_request_approval`, `ordering_decide_approval`, `ordering_v2_refund_confirm`는 별도 레거시 RPC이다.

## 1. 공통 계약
- 인증: Supabase Auth access JWT (`Authorization: Bearer`), 공개 클라이언트는 publishable key. service_role/secret key 브라우저 금지.
- 테넌트: 경로 `/v1/tenants/{tenantId}`의 UUID는 **선택자**일 뿐 권한 증거가 아니다. 매 요청 `auth.uid()`와 활성 `ordering_members`의 (tenant_id,user_id,role) 확인. 플랫폼 관리자라도 점주 권한 자동 상속 금지.
- 쓰기: `Idempotency-Key` 필수(UUID 또는 충분한 길이의 고유키); 같은 테넌트/작업/키/동일 payload는 같은 결과, 다른 payload는 `409 IDEMPOTENCY_CONFLICT`. `If-Match` 또는 `expectedVersion`을 상태 변경에 적용. PostgreSQL 트랜잭션에서 잠금·검증·원장·감사·outbox를 원자적으로 기록.
- 응답: `{data,meta:{requestId,version}}`; 실패 `{error:{code,message,details},requestId}`. 예상 HTTP: 400 유효성, 401 미인증, 403 권한, 404 다른 테넌트 포함 미노출 자원, 409 충돌, 422 업무 불변식, 503 외부 검증 장애.
- `payment_verified`는 외부 제공사 대사 결과 또는 명시적 수동 확인 사실로 구분. P0 수동 확인을 PG 승인 성공으로 표시하지 않는다.
- 모든 수량은 정수, 금액은 KRW bigint 정수, 시각은 UTC timestamptz, 고객 정보는 최소한으로 응답.

## 2. 엔드포인트 계약 (목표)
| 메서드/경로 (모두 `/v1/tenants/{tenantId}` 아래) | 역할 | 요청 핵심 | 응답/검증 |
|---|---|---|---|
| GET `/orders?status=&cursor=` | Owner/Staff | limit≤100 | 서점 주문만, 민감정보 최소화 |
| POST `/orders` | Owner/Staff | customerName, items[{bookKey,title,qty,unitPriceKrw}] | 201 orderId, DRAFT; 가격 스냅샷 |
| POST `/orders/{id}/confirm` | Owner/Staff | expectedVersion | 표시번호 발급(서점별 불변), 1개 이상 품목 |
| POST `/orders/{id}/cancel-requests` | Owner/Staff(위임 범위) | lineId,qty,reason | 공급처 취소와 별개; 전달 후 Owner 승인 |
| POST `/purchase-orders` | Owner/Staff | supplierCode, lines | DRAFT 발주 헤더 |
| POST `/purchase-orders/{id}/send` | Owner/Staff | expectedVersion | SENT, 원장·감사; 전송 증빙 |
| POST `/purchase-orders/{id}/cancellation-requests` | Owner/Staff | poLineId,qty | 외부 수락 전 공급처 의무 감소 금지 |
| POST `/receipts` | Owner/Staff | poLineId,acceptedQty,reference | 입고 로트+버킷; 초과 입고 승인 필요 |
| POST `/allocations` | Owner/Staff | orderLineId,lotId,qty | 동일 서점·도서·발주 연결, 주문 미확보 상한, 로트 잠금 |
| POST `/allocations/{id}/release` | Owner/Staff/승인조건 | qty,reason | 미인도량만 해제, 타 고객 재배분 Owner 승인 정책 확정 전 보류 |
| POST `/inventory/reservations` | Owner/Staff | orderLineId,bookKey,qty | 매장 가용재고 한도, 고객 직접 입고 중복 금지 |
| POST `/inventory/adjustments` | Owner/위임 Staff | bookKey,deltaQty,reason | Owner 기본, 원장 append-only |
| POST `/handovers` | Owner/Staff | allocationId,qty,allocatedAmountKrw | 미인도 수량·대상 결제금액 검증, 기본 후불 금지 |
| POST `/payments/attempts` | Owner/Staff | orderId,method,amountKrw,externalReference,evidence | REPORTED만 기록; 결제 원장 아직 미반영 |
| POST `/payments/attempts/{id}/verify` | Owner/Staff(수동), 서버(자동) | verificationSource,evidenceDigest,providerResult | 수동/제공사 확인 구분; 동일 거래 중복 반영 방지 |
| POST `/payments/attempts/{id}/post` | Owner/Staff | expectedVersion | 검증된 attempt만 PAYMENT 원장 1회 기록; 합계 상한 |
| POST `/approvals` | Owner/Staff | action,entityId,reason,evidence,expectedVersion | 승인 요청, 미지원 action은 실행 불가 |
| POST `/approvals/{id}/decide` | Owner | approve,expectedVersion | 요청 row lock; 대상 재검증; 1회 결정 |
| POST `/refunds/confirm` | Owner | approvalId,originalPaymentId,amountKrw,externalReference,refundEvidence | **외부 실제 환급 완료 증빙** + 원결제 한도 + Owner 승인; 내부 승인만으로 환급 완료 처리 금지 |
| POST `/exceptions/{id}/resolve` | Owner/Staff(정책별) | reason,evidence,expectedVersion | blocking 예외의 임의 waiver 금지; 미승인 DEC-16 경로 비활성 |
| POST `/orders/{id}/close` | Owner/Staff | expectedVersion | 주문 row lock, 수량/금액/외부 의무/예외/후속 처분 같은 트랜잭션 재검증 |
| GET `/audit?entityId=` | Owner | cursor,limit | 감사 조회; 직원 기본 제한 |

## 3. 대표 요청/응답
```http
POST /v1/tenants/{tenantId}/payments/attempts
Authorization: Bearer <access-jwt>
Idempotency-Key: 7f815e3c-57f0-46ad-aadb-9b034b4d101c
Content-Type: application/json

{"orderId":"<uuid>","method":"CARD","amountKrw":15000,"externalReference":"VAN-123","evidence":{"type":"MANUAL_RECEIPT","digest":"sha256:..."}}
```
```json
{"data":{"attemptId":"<uuid>","status":"REPORTED"},"meta":{"requestId":"<uuid>","version":1}}
```

## 4. 주문 종결 검증 의사코드
```
BEGIN;
SELECT order FOR UPDATE;
assert expected_version = current_version;
lock affected order lines, supplier PO lines, receipt lots in deterministic order;
E = sum(ordered_qty - cancelled_qty);
assert sum(net_delivered_qty) == E;
assert confirmed_payments - confirmed_refunds == effective_order_amount;
assert no blocking OPEN exception;
assert no unresolved supplier obligation (sent - accepted_reduction - received > 0);
assert no unresolved pending cancellation / undisposed receipt balance;
assert no invalid payment/refund evidence;
UPDATE order status='COMPLETED', version=version+1;
INSERT closure_check, audit, outbox;
COMMIT;
```
실제 구현은 **동일 트랜잭션에서 재집계**해야 하며, `ordering_order_closure_checks` 기록만으로 완료를 허용해서는 안 된다. 안내는 일률적 필수 종결 조건이 아니다(DEC-10).

## 5. 정책 미확정·단계 분리
- DEC-08 가격 변경, DEC-12 개인정보 보존, DEC-15 타 고객 재배분, DEC-16 예외 waiver는 확정 전 보수적으로 제한한다.
- P0는 외부 결제/환급의 **사실과 증빙 기록**; P2 실제 PG/VAN 승인·취소·환불 호출은 별도 계약과 API.
- 고객 공개 주문(P1), 공식 메시지 발송(P1), 실제 PG 연동(P2)은 P0 기본 엔드포인트로 공개하지 않는다.
- 실제 API 구현은 `ordering_v2_command`의 현재 Owner-only payment/complete 게이트와 충돌하므로 신규 RPC의 검증 완료 전 기존 함수를 교체하지 않는다.
