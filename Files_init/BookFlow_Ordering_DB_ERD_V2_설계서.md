# BookFlow Ordering — DB·ERD 목표 설계 V2.0 (검토안)

작성일 2026-11-22 · 대상 Supabase `ordering-dev` (`nywalirmzserjndlgfco`) · **운영 배포 보류 / DB 변경 미적용**

## 1. 문서 근거와 효력
실제 열람: `Ordering_OPDS_V1.1_승인정책반영본.md`, `Ordering_STBR_V1.2_OPDS_V1.1_동기화.md`, `Ordering_FRD_V1.3_OPDS_V1.1_동기화.md`, `Ordering_UseCase_V1.5_OPDS_V1.1_동기화.md`, `Ordering_보안_비판적재검토_V1.0.md`. 함께 Supabase 실DB의 `information_schema.columns`, `pg_constraint`, 현재 RPC 정의 및 일부 함수 EXECUTE 권한을 조회하였다. 본 문서는 **승인된 업무 정책**과 **새로운 구현 제안**을 명확히 구분한다. SQL/ERD는 검토·개발용이며 실행하거나 배포하지 않았다. 원본 문서 전체의 모든 문장과 실제 DB의 모든 함수 본문을 전수 대조했다고 주장하지 않는다.

우선순위: 사용자 명시 확정 > OPDS V1.1 승인 > 동기화 STBR > 이전 문서. 미승인 정책(DEC-08/12/15/16, D22/29 등)은 보류한다. P0 외부 결제 사실 *기록*과 P2 실제 PG/VAN *승인/취소*를 구분한다. 실제 고객 반품은 일반 정정으로 대체하지 않는다.

## 2. 실DB 현재 상태(확인된 사실)
15개 테이블: `ordering_tenants`, `ordering_members`, `ordering_orders`, `ordering_order_lines`, `ordering_supplier_po_lines`, `ordering_receipt_lots`, `ordering_receipt_dispositions`, `ordering_inventory_ledger`, `ordering_reservation_ledger`, `ordering_payment_ledger`, `ordering_customer_notices`, `ordering_events`, `ordering_approval_requests`, `ordering_audit_ledger`, `ordering_commands`.

- 주문 헤더는 `customer_name`, `book_title`, `qty`, `unit_price`, `status`, `order_number` 중심이고 **헤더 version, 확정/종결 시각, 고객 연락처, 고객 FK**가 없다. 품목에만 `version bigint`가 있다.
- 발주 품목은 `order_line_id`에 직접 연결된다. 여러 고객 주문 품목을 하나의 발주 품목으로 묶는 N:M 연결이 아직 없다.
- 입고 로트는 발주 품목과 연결되고 8버킷 처분 테이블을 사용하나 **버킷별 고객 주문 품목 FK**가 없다. 고객별 배분량의 물리적 귀속이 불명확하다.
- 결제 원장에 외부 거래 참조번호, 원결제 참조, 확인 시각은 있지만 **증빙 출처, 검증자, 증빙 해시, 검증 상태, 거래 확인 절차**가 없다.
- 승인 요청은 액션·증빙 JSONB·결정 상태가 있지만 **대상 버전·만료/재검증 계약**이 없다.
- `ordering_v2_command`는 Staff의 `payment`와 `complete`를 일률 차단해 OPDS V1.1의 '외부 결제 사실 등록' 및 '종결 요청' 정책과 충돌한다.
- 기존 `ordering_request_approval`의 환급 요청 증빙 필수 검사 보강은 반영되어 있다. 19/19 브라우저 차단 사례 통과와 SQL 롤백 테스트는 실제 JWT Staff/병렬 두 세션 테스트를 대체하지 않는다.

## 3. 설계 원칙
1. 모든 서점 업무 데이터에 `tenant_id`; 부모/자식 FK는 가능하면 `(tenant_id,id)` 복합 FK, 해당 부모에 `UNIQUE(tenant_id,id)` 확보.
2. 인증 `auth.users.id`와 서점 회원(`ordering_members`) 연결; Owner/Staff 권한은 서버에서 활성 멤버십 재조회. 플랫폼 관리자는 Owner 권한 자동 상속 금지.
3. 변경 가능한 상태는 명령 함수만 변경; 금전·재고·예약·입고 처분은 append-only 사실/이동 이벤트를 원천으로 유지. 현재 버킷 테이블은 전환 기간에 잔액 프로젝션으로 사용.
4. 거래 식별: `request_key`(API 재시도), `external_reference`(외부 실제 거래), `approval_request_id`(승인 건)를 별도 유일성으로 관리.
5. 결제 시도/확인 증빙/확정 결제 원장 분리; 확인 실패·불명확 시 원장 반영 금지. 수동 확인은 검증 절차·담당자·시각·근거를 기록하지만 P0에서 자동 PG 검증을 가장하지 않는다.
6. 공급처 의무, 고객 취소, 입고, 고객별 배분, 인도, 반품/편입을 각각 별도 수량으로 추적. 외부 의무가 남으면 주문 종결 금지.
7. 중요한 명령에 행 잠금 또는 일관된 advisory lock, 예상 `version`, 서버 재검증, 감사·원장 단일 DB 트랜잭션.
8. 외부 API/메시지 등 DB 밖의 부작용은 outbox와 결과 확인으로 처리; 외부 호출을 DB 트랜잭션 성공과 혼동하지 않음.

## 4. 목표 논리 테이블 사전
표의 **기존**은 현재 실DB 존재, **신규**는 제안, **확장**은 기존 테이블의 후속 컬럼/제약 제안이다.

| 구분 | 테이블 | 주요 키/컬럼 | 관계 및 용도 |
|---|---|---|---|
| 기존 | ordering_tenants | id PK, name | 서점 1개=초기 매장 1개 |
| 기존 | ordering_members | (tenant_id,user_id) PK, role, active | auth.users와 연결 |
| 확장 | ordering_orders | id PK, tenant_id, order_number, status, **version, confirmed_at, closed_at, customer_id** | 서점 주문; 표시번호는 확정 시 서점별 유일 발급 |
| 기존/확장 | ordering_order_lines | id, tenant_id, order_id, book_key, ordered_qty, cancelled_qty, unit_price_krw, version | 확정 시 가격/제목 스냅샷 |
| 신규 | ordering_customers | id, tenant_id, display_name, phone_ciphertext 또는 보안 별도 저장, created_at | 연락처 보유기간은 미승인; 접근 최소화 |
| 신규 | ordering_books | id, tenant_id NULL(공통 서지 후보), isbn, title, source, metadata | YES24 단일 API·수기 입력; 공통 서지/개별 가격 구분은 추가 검토 |
| 기존/확장 | ordering_supplier_po_lines | id, tenant_id, order_line_id(전환 중), supplier_code, sent_qty, supplier_accepted_reduction, status | 기존 연결은 유지하면서 신규 집계 발주 모델로 전환 |
| 신규 | ordering_purchase_orders | id, tenant_id, supplier_code, status, sent_at, version | 공급처 발주 헤더 |
| 신규 | ordering_po_order_allocations | id, tenant_id, po_line_id, order_line_id, linked_qty | 발주 품목 ↔ 고객 주문 품목 N:M; 기존 데이터 백필 후 적용 |
| 신규 | ordering_supplier_cancel_requests | id, tenant_id, po_line_id, requested_qty, accepted_qty, status, external_ref | 고객 취소와 공급처 수락량 분리 |
| 기존 | ordering_receipt_lots | id, tenant_id, po_line_id, accepted_qty, received_at | 검수된 순입고량 |
| 기존/확장 | ordering_receipt_dispositions | id, tenant_id, receipt_lot_id, bucket, qty | 8버킷 잔액 프로젝션; 직접 수정 차단 |
| 신규 | ordering_lot_movements | id, tenant_id, lot_id, from_bucket, to_bucket, qty, order_line_id NULL, approval_id NULL, command_key | 버킷 간 허용 전이의 append-only 기록 |
| 신규 | ordering_order_allocations | id, tenant_id, order_line_id, lot_id, allocated_qty, delivered_qty, released_qty, version | 고객별 로트 귀속; 합계 상한 검증 |
| 기존 | ordering_inventory_ledger | id, tenant_id, book_key, kind, delta_qty, source_type, source_id, approved_by | 매장 보유 재고 수불 원장 |
| 기존 | ordering_reservation_ledger | id, tenant_id, order_line_id, book_key, delta_qty, reason | 매장 보유분 예약 원장 |
| 신규 | ordering_stock_transfers | id, tenant_id, lot_id, qty, inventory_entry_id, approved_by | 고객 주문용 로트 → 매장 재고 편입의 단일 연결 |
| 신규 | ordering_supplier_returns | id, tenant_id, lot_id, requested_qty, accepted_qty, dispatched_qty, completed_qty, status, approved_by | 반품 수락/출고/완료 및 미회수 별도 추적 |
| 신규 | ordering_order_cancel_requests | id, tenant_id, order_line_id, requested_qty, status, requested_at, resolved_at | 취소 대기 중 인도 제한, 만료시간은 미결정 |
| 신규 | ordering_exceptions | id, tenant_id, order_id, type, blocking, status, reason, resolved_by, resolved_at | 필수 미해결 예외를 종결 게이트에 반영 |
| 기존/확장 | ordering_customer_notices | id, tenant_id, order_id, channel, status, evidence | 시도/복사/실제 발송 결과 구분 필요 |
| 신규 | ordering_notice_attempts | id, tenant_id, order_id, notice_id, attempt_status, provider_ref, attempted_at, confirmed_at | 부분/전체 확보 선택, 실패 재안내 |
| 신규 | ordering_handover_lines | id, tenant_id, order_line_id, qty, allocated_amount_krw, handed_at, command_key | 고객 인도량과 인도 대상 결제액 연결 |
| 신규 | ordering_payment_attempts | id, tenant_id, order_id, method, amount_krw, external_reference, status, request_key | P0 수동 확인 후보, 미확정 시 원장 미반영 |
| 신규 | ordering_payment_evidence | id, tenant_id, attempt_id, source_type, source_reference, evidence_digest, verified_by, verified_at, verification_result | 검증 출처/담당자/결과; 원문 민감 증빙 저장 최소화 |
| 기존/확장 | ordering_payment_ledger | id, tenant_id, order_id, kind, amount_krw, method, external_reference, original_payment_id, approved_by, verified_at, **attempt_id** | 확인된 결제/환급만 원장 반영 |
| 기존/확장 | ordering_approval_requests | id, tenant_id, action, entity_id, evidence, status, requested_by, decided_by, **expected_version** | Owner 승인 및 재검증; 비환급 액션은 구현 게이트 유지 |
| 신규 | ordering_order_closure_checks | id, tenant_id, order_id, checked_version, delivered_ok, money_ok, supplier_ok, disposition_ok, exceptions_ok, result, checked_at | 종결 판단 근거 스냅샷; 실제 조건은 서버 재계산 |
| 기존 | ordering_audit_ledger | id, tenant_id, actor_user_id, action, entity_type, entity_id, reason, details | 민감 명령 감사 |
| 기존 | ordering_commands | (tenant_id,command_key) PK, payload_hash, result | 멱등성 결과 저장 |
| 신규 | ordering_outbox | id, tenant_id, aggregate_type, aggregate_id, event_type, payload, status, attempts, next_attempt_at | 외부 메시지·대사 후속 처리 |

## 5. ERD 읽기
전체 ERD는 별도 `.mmd` 파일을 참조. 기존 테이블과 신규 테이블을 함께 표시한 **목표 논리 ERD**이다. 기존 DB에서 실제로 존재하는 물리 FK와 설계상 FK를 혼동하지 말 것. 특히 발주 N:M, 로트별 고객 배분, 결제 증빙, 환급 승인, 예외 종결은 *미적용 제안*이다.

## 6. 수량·금액 불변식 (승인 정책의 구현 계약)
- 주문라인 `effective_qty = ordered_qty - cancelled_qty >= 0`.
- 주문라인별 `delivered_net + allocated_open + reserved_open <= effective_qty`. 동일 로트의 allocated/delivered 합과 주문라인 귀속을 교차 검증.
- 로트별 `SUM(8개 bucket qty) = accepted_qty`이며 모든 qty ≥ 0. 로트의 tenant/PO/도서와 주문라인의 tenant/도서가 일치해야 함.
- 버킷 이동은 허용된 `from → to`만 허용; 예: UNALLOCATED→ALLOCATED_OPEN, ALLOCATED_OPEN→DELIVERED_NET, UNALLOCATED→DISPOSITION_PENDING, DISPOSITION_PENDING→RETURN_HELD 또는 STOCK_TRANSFERRED. 나머지는 별도 승인 전 차단. 역전이는 승인된 정정 명령에서만 허용.
- 매장재고 `available = inventory_sum - reservation_sum >= 0`; 주문용 로트는 `STOCK_TRANSFERRED` 승인 후 정확히 1회 매장 원장에 반영. 직접 입고를 매장 재고로 자동 편입 금지.
- 발주 `supplier_obligation = sent_qty - supplier_accepted_reduction`; 고객 취소만으로 외부 의무 차감 금지. 입고 초과량은 Owner 승인/처분 대기.
- 결제 `balance = effective_order_amount - confirmed_payments + confirmed_refunds`; 환급은 원결제액과 전체 순결제액을 초과할 수 없음. 미확정 attempt는 원장 제외.
- 인도 전 인도 대상 금액 결제 충족; 취소 대기 대상 수량은 인도 불가. 할인/배송비 자동 계산은 P0 범위 밖.
- 종결: 유효 주문량>0이면 전량 순인도 + 잔액 0 + 필수 예외 없음 + 공급처 의무/잔여 물량 후속 완료. 유효 주문량=0이면 모든 외부·물량·금전 후속 완료. 완료 후 정정은 D21 승인 역거래 및 재개 절차만.

## 7. 상태 전이 계약
| 객체 | 허용 흐름(설계안) | 필수 가드 |
|---|---|---|
| 주문 | DRAFT→CONFIRMED→IN_PROGRESS→COMPLETED; 취소 요청·재개는 별도 명령 | 표시번호/버전/원장 종결 조건 |
| 취소 요청 | PENDING→ACCEPTED/REJECTED/WITHDRAWN | 요청량 인도 잠금, Owner 승인 대상 구분 |
| 공급처 취소 | REQUESTED→ACCEPTED/PARTIAL/REJECTED | 외부 수락량만 의무 차감 |
| 결제 시도 | RECORDED→EVIDENCE_PENDING→VERIFIED/REJECTED/UNKNOWN | 검증 담당자·증빙·실제 참조번호 |
| 환급 승인 | PENDING→APPROVED/REJECTED | Owner, 원거래·증빙·버전 재검증 |
| 예외 | OPEN→RESOLVED; 필요 시 REOPENED | 해결 근거·담당자·감사 |
| 반품 | REQUESTED→ACCEPTED→DISPATCHED→COMPLETED | 수량별 추적, 미회수 재고 편입 금지 |

**주의:** 상태 문자열과 일부 전이는 구현 제안이다. 미승인 예외 종결(DEC-16), 타 고객 재배분(DEC-15), 가격 변경(DEC-08)은 별도 승인 전 활성화하지 않는다.

## 8. RLS·권한 설계
- 신규 public 테이블은 생성 트랜잭션 내 RLS ON, `anon` 전면 거부, `authenticated` SELECT는 `ordering_members` 활성 멤버십 기반 tenant 격리. 고객 연락처/증빙 원문은 별도 최소권한 또는 비공개 스키마 권장.
- 금전·재고·배분·승인·감사 테이블은 브라우저 직접 INSERT/UPDATE/DELETE 금지; 업무 RPC만 사용. `SECURITY DEFINER`는 최소 공개 함수에만 허용하고 `search_path` 고정, 모든 함수에서 `auth.uid()` 및 tenant/role 재검증.
- `ordering_v2_transfer_bucket` 등 내부 함수 EXECUTE는 현재 authenticated/anon에서 거부됨을 확인. 앞으로도 내부 함수를 공개 API로 승격하지 않음.
- Staff: 정상 주문/발주/입고/배분/예약/안내/인도/검증된 외부 결제 사실 등록/종결 요청. Owner: 환급 확정/정정/반품 편입/초과입고 승인 및 초기 재고 조정. Staff 직접 `complete` 대신 `request_completion`으로 분리해 서버 검증.
- 승인 요청 시 대상 주문의 예상 버전과 증빙을 저장하고 승인 시 최신 버전·외부 참조·원장 잔액을 다시 검증. 승인과 환급 원장 1회 기록은 같은 트랜잭션.

## 9. 기존 DB 의존성 및 마이그레이션 전략
**현재 DB를 변경하지 않는다.**
1. 스냅샷: `pg_get_functiondef`, 트리거 정의, FK/인덱스/RLS/권한, 데이터 건수, 무결성 이상 건수, DB 백업·복구 절차 확보.
2. 신규 테이블 추가만 하는 `expand` 마이그레이션 초안 작성. 기존 테이블/함수/트리거를 DROP하지 않는다.
3. 기존 발주-주문라인 관계에서 N:M 연결 테이블 백필, 기존 로트 disposition을 movement 초기 잔액으로 이관. 기존 데이터에 존재하지 않는 고객별 귀속은 **추정해서 생성하지 말고 수동 검증 대기**.
4. 검증 전환: 새 원장과 기존 잔액 동시 기록은 이중 계상 방지 설계 후에만. DB 내 단일 트랜잭션에서 상태/원장/감사/outbox 기록.
5. 검증 후 API를 명시적 버전으로 교체하고 구형 API 호출 모니터링. `contract` 단계는 실제 Staff JWT·병렬 테스트·백업 복구·기존 19개 회귀 후 승인.
6. 롤백: 기능 플래그 비활성/구 RPC 복귀 우선. 신규 원장에 실제 업무 데이터가 들어간 뒤에는 무조건 DROP/복구 금지; 역방향 데이터 변환 계획 필요.

## 10. 회귀·보안 검증 매트릭스
| ID | 검증 | 기대 결과 |
|---|---|---|
| SEC-01 | 기존 19개 JWT 브라우저 테스트 | 전부 통과; 단 Owner 교차 테넌트 거부 사유를 독립 확인 |
| SEC-02 | 실제 별도 Staff 로그인 | 허용 명령 성공/Owner 전용 명령 거부, 권한 회수 후 즉시 차단 |
| CON-01 | 독립 DB 세션 2개 동일 승인 동시 호출 | 승인 상태 1회 전이, 환급 원장 1건 |
| CON-02 | 서로 다른 멱등키로 동일 외부 환급 참조 동시 호출 | 1건만 성공, 나머지 유일성 충돌 |
| CON-03 | 마지막 1권 동시 예약/배분 | 합계 상한 보존 |
| PAY-01 | 외부 참조 없는 결제/불명확 상태 | 확정 원장 0건 |
| PAY-02 | 부분/복수 결제·부분 환급·원결제 상한 | 금액 보존 |
| CLS-01 | 미해결 공급처 취소/초과입고/예외 상태 | 종결 차단 |
| CLS-02 | 유효량 0 전량 취소 및 후속 모두 완료 | 종결 허용 |
| LOT-01 | 허용되지 않은 버킷 이동/고객별 초과 배분 | 거부 |
| LOT-02 | 로트 재고 편입 재시도 | 매장 원장 정확히 1회 |
| OPS-01 | 승인 후 요청 유실/재시도/버전 충돌 | 중복 부작용 없음 |
| OPS-02 | RLS/SECURITY DEFINER/GRANT/백업 복원 | 권한 누출 없음, 복원 검증 |

## 11. 설계 결함 및 보류 게이트
- 현재 원결제/환급 `external_reference`는 DB 유일 제약이 있지만, 그것만으로 외부 실제 거래 확인을 증명하지 않는다.
- 현행 로트 disposition은 잔액 테이블이므로 이동 이력을 원장으로 추가하되 기존 트리거의 `SUM(bucket)=accepted_qty` 검사와 중복·충돌하지 않게 해야 한다.
- Staff의 결제 기록 허용은 증빙 검증 프로세스 확정 후 적용. 현재 일률 차단은 정책 불일치이나 무검증 권한 개방도 금지.
- 완료 주문 환급 차단은 임시 안전장치이며 D21 재개·역거래가 마련될 때까지 운영 제약으로 남는다.
- 개인정보 보존 기간, 취소 만료시간, 미승인 재배분/예외 종결, 외부 PG/VAN 계약은 본 설계가 임의로 확정하지 않는다.

## 12. 완료 기준
DB/ERD 설계서 작성은 완료. **실제 스키마 마이그레이션, 신규 RPC 구현, 독립 JWT/병렬 회귀 검증은 미완료**. 운영 배포 보류를 유지한다.
