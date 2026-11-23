# Ordering Supabase 정식 원장 확장 — 1차 적용 및 검증 보고 V1.0

기준: OPDS V1.1, STBR V1.2 (2026-11-22)
프로젝트: `ordering-dev` / `nywalirmzserjndlgfco` / 서울

## 실제 수행
- 신규 정규화 테이블 9개 생성: `ordering_order_lines`, `ordering_supplier_po_lines`, `ordering_receipt_lots`, `ordering_receipt_dispositions`, `ordering_inventory_ledger`, `ordering_reservation_ledger`, `ordering_payment_ledger`, `ordering_audit_ledger`, `ordering_customer_notices`.
- 신규 테이블 RLS 활성화, 활성 tenant membership 기준 SELECT 정책 생성, 인증 사용자 직접 INSERT/UPDATE/DELETE 미허용.
- 결제 원장에 거래번호 테넌트별/종류별 유일성, 환급의 원결제 연결 및 승인자 필수 제약을 적용.
- 이전 검증용 `ordering_p0_command`는 새 원장을 쓰지 않으므로 `authenticated` EXECUTE 권한을 회수함.
- 실제 SQL 조회로 인증 사용자 결제/재고 원장 직접 INSERT 권한이 모두 false임을 확인.

## 검증 상태
| 항목 | 결과 |
|---|---|
| 9개 정규화 테이블 DDL | 적용 성공 |
| 원장 직접 쓰기 권한 차단 | SQL 확인 성공 |
| 실제 Supabase Auth 이메일/비밀번호 로그인 | 미실행: 테스트 계정·세션 미준비 |
| JWT 포함 HTTP REST API | 미실행: 로그인 세션과 HTTP 실행 경로 미준비 |
| 정규화 원장 기반 8단계 거래 | 미실행: 새 RPC/트랜잭션 미구현 |
| 8개 버킷 총량 보존 | DB 집계/전이 트리거 미구현 |
| 환급 원결제 잔여 상한 | DB 제약·거래 검증 미구현 |
| 동시성, 멱등 충돌, 감사 | 정식 원장 명령 경로 미구현 |

## 주의할 설계 격차
- 현재 8개 귀속 버킷은 테이블 및 enum형 체크 제약만 있으며, 로트 총량과 일치한다는 보장은 없다.
- 주문 표시번호는 과거 검증용 전역 identity이며 OPDS의 **서점별** 발급 정책을 아직 충족하지 않는다.
- 기존 단순 8단계 검증용 테이블과 새 정규화 테이블은 병존한다. 기존 테스트 통과를 새 원장 검증 통과로 해석하면 안 된다.
- `ordering_payment_ledger`의 REFUND 승인자 NOT NULL과 원결제 FK는 일부 정책만 표현하며 환급액 상한, 실제 외부 결과 검증, Owner 권한 확인은 트랜잭션 구현이 필요하다.
- 현재 테스트용 회원 UUID는 실제 Supabase Auth 계정과 연결된 로그인 세션이 아니다.

## 다음 단계
1. Supabase Auth 테스트 계정 두 명을 생성하고 각각 다른 tenant에 회원으로 연결.
2. 최소권한 원자적 업무 RPC를 설계·구현하고 서버에서 활성 소속/Owner 승인/금액·수량·버전·멱등 검증.
3. REST API에서 실제 사용자 access token을 사용해 정상 흐름 및 교차 tenant 접근 차단 검증.
4. 환급, 반품, 취소, 실물 귀속, 동시성, 감사 보존 미결정 항목은 OPDS 승인 게이트 유지.
5. 보안 Advisor 재실행 및 REST 응답·SQL 결과를 첨부한 최종 인수 보고.

**결론:** 정규화 원장 스키마 1차 구축 완료. Auth·REST·정식 원장 업무 검증은 미완료이며 운영 배포 불가.
