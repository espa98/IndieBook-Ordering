# BookFlow Ordering ERD V2.1 — 비판적 검토 및 개정서

2026-11-22 · 대상: ordering-dev · **설계 산출물만 변경, 실DB 미변경, 운영 배포 보류**

## 1. 검토한 원본과 기준
- `BookFlow_Ordering_ERD_V2.mmd` 전체 관계 및 엔티티 선언
- `BookFlow_Ordering_DB_ERD_V2_설계서.md` 전체 12개 장
- `Ordering_OPDS_V1.1_승인정책반영본.md` 확정 정책/미결정 구분
- 실DB 15개 ordering_* 테이블의 컬럼 목록과 제약 조회 결과(이전 설계 시점 확인 자료)

원본은 **목표 논리 ERD**이며 실DB 물리 스키마가 아니다. 이번 변경은 이 구분을 유지한다. 신규 테이블의 구체적인 컬럼/제약은 설계안이며 확정 정책으로 가장하지 않는다.

## 2. 비판적 발견과 반영

| ID | V2.0 문제 | 위험 | V2.1 반영 |
|---|---|---|---|
| ERD-01 | `ordering_books`가 독립 엔티티로 고립 | 공통 서지와 주문 스냅샷 관계 불명확 | 책→주문라인의 **선택적** 논리 참조 추가; `book_key` 전환 전 강제 FK 금지 |
| ERD-02 | `ordering_purchase_orders`와 `ordering_supplier_po_lines` 간 부모 관계는 있으나 품목에 `purchase_order_id` 미표시 | 물리 구현 불가능 | 품목에 `purchase_order_id` 제안 컬럼 추가 |
| ERD-03 | N:M 발주 모델인데 기존 품목의 `order_line_id`가 동시에 존재 | 이중 귀속/이중 계상 | `order_line_id`는 전환용 legacy로 명시, 백필 후 **읽기 전용**, 신규 연결만 원천으로 삼기 |
| ERD-04 | 고객과 주문 관계가 필수처럼 보임 | 기존 주문에 customer_id 없음 | 고객→주문 관계 선택적으로 표시, 백필 검증 전 NOT NULL 금지 |
| ERD-05 | 주문→품목이 반드시 1건 이상 | DRAFT 생성 단계에서 불필요한 강제 | 0..N으로 조정, CONFIRMED 전 1건 이상 서버 검증 |
| ERD-06 | 고객 인도 기록과 특정 배분 연결 없음 | 같은 물량 이중 인도 | `ordering_handover_lines.allocation_id` 및 관계 추가 |
| ERD-07 | 원결제→환급 관계가 도식에서 빠짐 | 환급 귀속과 상한 추적 어려움 | payment ledger 자기참조 관계 추가; 복합 tenant/order FK 제안 |
| ERD-08 | 신규 테이블의 tenant_id 표시가 누락되거나 FK에 tenant 보장 미표기 | 교차 서점 참조 | 모든 서점별 테이블 tenant_id, `(tenant_id,id)` 유일성 및 복합 FK 원칙을 필수 구현 계약으로 명시 |
| ERD-09 | 결제 attempt→ledger가 사실상 1:1로 읽힘 | 환급/정정에는 attempt가 없을 수 있음 | 선택적 0..1 관계, PAYMENT에 한정해 확인된 attempt 필수화 제안 |
| ERD-10 | 배분 수량과 버킷 수량이 별도 집계 원천 | 드리프트/중복 집계 | movement를 사실 원장, dispositions는 잔액 프로젝션, allocations는 고객 귀속 프로젝션으로 역할 구분 |
| ERD-11 | 고객별 배분 상한 공식에 예약량과 입고배분량을 무조건 합산 | 서로 다른 조달 경로의 중복/오차 | 매장 예약과 공급처 로트 배분을 출처별 분리하고 동일 수량을 두 번 계산하지 않는 합산 규칙 필요 |
| ERD-12 | 환급 참조번호 유일성이 외부 실제 거래를 보증하는 것처럼 해석될 수 있음 | 허위 증빙 | 수동 확인(P0)과 공급사 자동 대사(P2) 상태를 분리; 승인과 외부 환급 성공은 별도 사실 |
| ERD-13 | 승인 `entity_id`는 다형 FK로 실체를 보장하지 못함 | 존재하지 않는 대상 승인 | action별 서버 검증, `entity_type` 및 대상 버전/스냅샷, 승인 시 재검증; 범용 FK라고 주장 금지 |
| ERD-14 | 종결 체크 기록만으로 종결 안전성을 보장할 수 없음 | 체크 후 주문 변경 TOCTOU | 동일 트랜잭션에서 주문 잠금·버전 비교·원장 재집계·종결 변경·감사 기록 |
| ERD-15 | 전량 취소/입고 잔여량 처분과 공급처 취소 수락량의 관계 미세분화 | 공급처 미이행 잔여분 누락 | `sent - accepted_reduction - received`의 미입고 의무 및 입고 잔여 처분을 각각 검사; 중복 차감 금지 |

## 3. V2.1 관계 및 데이터 계약

### 3.1 식별자와 테넌트 격리
- 모든 tenant-scoped 부모에 `UNIQUE(tenant_id,id)`를 마련한 뒤 자식에 `(tenant_id,parent_id)` 복합 FK를 둔다. `ordering_members`는 `(tenant_id,user_id)` PK 유지.
- `ordering_books`는 공통 서지 후보이므로 tenant_id NULL이 섞인 복합 FK를 **사용하지 않는다**. 글로벌 서지와 서점별 취급/가격은 추후 별도 테이블로 구분. 기존 `book_key`를 자동 변환하지 않는다.
- `ordering_payment_ledger.original_payment_id`는 동일 tenant와 order의 `PAYMENT`만 가리키도록 함수 검증 + 복합 FK를 검토한다. FK 자체는 kind=PAYMENT를 보증하지 못한다.

### 3.2 발주·입고·고객 귀속
- 기존 발주 품목 `order_line_id`를 기준으로 N:M 연결을 백필하고 일치 건수/수량을 검증한다. 이후 신규 연결의 유일 원천을 `ordering_po_order_allocations`로 고정한다.
- 발주 연결 합계 ≤ 발주 품목 수량; 동일 주문라인의 확보량은 주문 잔량 상한을 초과할 수 없다. 단, 부분 취소/공급처 수락/실입고가 서로 다른 상태라는 점을 유지한다.
- 입고 로트별 accepted_qty = 8버킷 잔액 합계. `lot_movements`는 append-only이며 `receipt_dispositions`의 버킷별 잔액과 정확히 대사한다. 전환 시 시작 잔액 이벤트는 **기존 사실로 오인하지 않도록** `MIGRATION_OPENING` 유형으로 분리한다.
- `order_allocations`는 고객별 귀속량, `handover_lines`는 실제 인도 사건이다. `allocated_qty`, `released_qty`, `delivered_qty`가 이벤트에서 계산된 캐시라면 직접 수정하지 않고 원장과 교차 대사한다.
- 매장 재고 편입은 `stock_transfers`의 **1건당 정확히 1건**의 `inventory_ledger` 입고와 연결한다. 기존 재고 원장에는 source_type/source_id가 있어 이중 기록 방지 키를 추가 검토한다.

### 3.3 결제·환급·종결
- P0 직원의 외부 결제 사실 기록은 **증빙 출처/금액/거래번호/확인자/확인시각**을 저장한다. 수동 확인은 외부 시스템이 보증한 사실로 표시하지 않는다.
- PAYMENT ledger는 검증 완료된 attempt와 연결한다는 것이 목표. REFUND는 Owner 승인과 원결제·외부 환급 근거를 별도로 요구하며 환급 실제 실행 성공과 내부 승인 완료를 혼동하지 않는다.
- 원결제 금액 대비 누적 환급 한도는 **원결제 행 잠금 하에** 재계산하고, 서로 다른 idempotency key/동일 외부 참조에 대해서도 유일 제약을 둔다.
- 종결 시 `effective_qty`, 인도량, 결제 잔액, 미해결 예외, 발주 미입고 의무, 입고 잔여분 후속 처리, 취소 대기량을 같은 트랜잭션에서 재검증한다. 안내 자체는 일률적인 종결 필수조건이 아님(OPDS DEC-10).

## 4. V2.1 논리 ERD 수정 범위
`BookFlow_Ordering_ERD_V2.1_개선본.mmd` 참조. 표기된 FK는 **목표 관계**이고 실DB에 이미 설치된 FK가 아니다. `ordering_payment_attempts → ordering_payment_ledger`의 선택성, `ordering_customers → ordering_orders`의 선택성, `ordering_order_allocations → ordering_handover_lines`의 연결을 확인할 것.

## 5. 추가로 필요한 물리 스키마 결정
1. **복합 FK:** 자식 테이블의 `tenant_id` 및 참조 ID를 함께 사용. 기존 orphan/cross-tenant 건수 0 확인 후 `NOT VALID` → 검증 → `VALIDATE CONSTRAINT`.
2. **수량 체크:** `qty > 0`인 이동 이벤트, 잔액 프로젝션 `qty >= 0`, 주문 취소 `0 <= cancelled_qty <= ordered_qty`.
3. **유일 키:** `(tenant_id,command_key)`; 외부 거래 참조 `(tenant_id,kind,external_reference)`; 고객 귀속 `(tenant_id,order_line_id,lot_id)`는 여러 이벤트를 별도 원장에 남기는 경우에만 프로젝션 고유키로 사용.
4. **RLS:** 공개 스키마의 신규 테이블은 생성과 동시에 RLS 활성화; 일반 직원 직접 원장 DML 금지. `SECURITY DEFINER`는 공개 진입점 최소화 및 내부 함수 권한 회수.
5. **개인정보:** 고객 연락처/결제 증빙 원문은 접근 최소화·암호화·보존기간 법률 검토 후 저장 정책 결정. ERD의 고객 테이블에 원문 전화번호를 무심코 추가하지 않는다.
6. **상태/승인:** `approval_requests.entity_id` 다형 참조는 별도 `entity_type`, 대상 버전과 요청 시 스냅샷이 필요. 승인 후 대상 상태 변경 시 자동 재승인하지 않고 재검증 실패 처리.
7. **환급/종결 후 정정:** 기존 completed 환급 차단은 재개·역거래 구현 전까지 유지. P0 외부 환급 증빙 기록과 실제 PG 환불 호출은 분리.

## 6. 변경 적용 범위 및 검증 게이트
- **이번에 적용한 것:** 목표 논리 ERD 파일과 검토·개정서만 수정. 기존 V2.0 원본 파일은 보존.
- **이번에 적용하지 않은 것:** Supabase 운영/개발 DB의 CREATE/ALTER/DROP, 기존 RPC 교체, RLS 변경, 신규 테스트 계정 생성.
- **다음 선행 검증:** 실DB의 전체 FK/인덱스/RLS/트리거/함수 의존성 스냅샷, 기존 데이터 이상치 분석, 격리 DB에 expand SQL 적용, 기존 19개 JWT 테스트, 실제 Staff JWT, 두 독립 세션 병렬 환급 및 마지막 1권 동시 배분.
- **출시 판단:** 보류. 이 문서의 설계 제안은 검증 완료나 정책 자동 승인으로 해석하지 않는다.
