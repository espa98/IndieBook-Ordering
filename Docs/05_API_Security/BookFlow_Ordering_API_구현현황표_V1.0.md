# BookFlow Ordering API 구현 현황표 V1.0

작성 기준: API 명세 V2.2, RLS 정책 V2.2, RPC·RLS 초기구현 V2.3, `ordering-dev` 공개 스키마의 함수 목록 읽기 전용 조회(2026-11-22).

**판정 기준**: `기존 RPC 존재`는 함수가 DB에 존재함만 뜻하며 V2.2 계약 준수나 검증 통과를 뜻하지 않음. `SQL 초안`은 파일만 작성됨. `미구현/미확인`은 문서 및 확인한 DB 목록에서 대응 구현 증거가 없음. 외부 `/v1/` HTTP 라우터는 모두 **제안 경로**이며 배포 확인되지 않음.

## A. V2.2 제안 API별 구현 현황

|ID|영역|메서드·경로(공통 `/v1/tenants/{tenantId}`)|권한|상태|현재 근거/차이|선행 작업|우선순위|
|---|---|---|---|---|---|---|---|
|API-01|주문|GET `/orders`|Owner/Staff|미구현/미확인|HTTP 라우터 미확인|tenant별 최소필드·커서 조회|P0|
|API-02|주문|GET `/orders/{orderId}`|Owner/Staff|미구현/미확인|동일|주문/품목 집계 조회·개인정보 필터|P0|
|API-03|주문|POST `/orders`|Owner/Staff|기존 RPC 존재·계약 불일치|`ordering_v2_command` 존재, V2.2 다품목·버전 계약 검증 안 됨|새 명령 계약·멱등성|P0|
|API-04|주문|POST `/orders/{id}/confirm`|Owner/Staff|기존 RPC 존재·계약 불일치|`ordering_v2_command` 존재, 실제 action 매핑 미확인|품목·가격·tenant별 주문번호·버전|P0|
|API-05|주문|POST `/orders/{id}/cancel-requests`|Owner/Staff|미구현/미확인|취소요청 테이블 목표 설계만 확인|주문 취소와 PO 취소 분리·승인|P0|
|API-06|발주|POST `/purchase-orders`|Owner/Staff|미구현/미확인|N:M 신규 스키마 초안|헤더/품목·수량 상한|P0|
|API-07|발주|POST `/purchase-orders/{id}/send`|Owner/Staff|미구현/미확인|발주 전송 RPC 미확인|외부 전송 증빙·재시도|P0|
|API-08|발주|POST `/purchase-orders/{id}/cancellation-requests`|Owner/Staff|미구현/미확인|수락 감량과 요청 분리 필요|공급처 확인 전 의무 유지|P0|
|API-09|입고|POST `/receipts`|Owner/Staff|미구현/미확인|기존 입고 테이블·버킷 트리거 존재, API는 미확인|입고/검수·8버킷 보존|P0|
|API-10|배분|POST `/allocations`|Owner/Staff|미구현/미확인|고객별 배분 RPC 미확인|주문/로트 잠금·상한·원장|P0|
|API-11|배분|POST `/allocations/{id}/release`|Owner/Staff·승인|미구현/미확인|재배분 정책 일부 미확정|인도분 해제 금지·감사|P1|
|API-12|인도|POST `/handovers`|Owner/Staff|미구현/미확인|인도 전용 RPC 미확인|결제 충족·고객 귀속·원장|P0|
|API-13|재고|POST `/inventory/reservations`|Owner/Staff|기존 RPC 존재·계약 불일치|`ordering_v2_command`·예약원장 트리거 존재, V2.2 API 매핑 미확인|매장 재고 vs 고객 입고 구분|P0|
|API-14|재고|POST `/inventory/adjustment-requests`|Owner/Staff|기존 승인 RPC 존재·액션 미확인|`ordering_request_approval` 존재, 해당 action 구현 확인 필요|조정 승인/역분개|P1|
|API-15|결제|POST `/payments/attempts`|Owner/Staff|미구현/미확인|V2.1 결제시도 테이블 SQL 초안만|증빙·중복 외부참조|P0|
|API-16|결제|POST `/payments/attempts/{id}/manual-review`|Owner/Staff·조건|미구현/미확인|`MANUAL_VERIFIED` vs `MANUAL_REVIEWED` 미정합|검증 출처·책임·상태 매핑|P0|
|API-17|결제|POST `/payments/attempts/{id}/provider-verify`|서버|미구현/미확인|PG/VAN 제공사 검증은 P2|서명·거래ID·금액 검증|P2|
|API-18|결제|POST `/payments/attempts/{id}/post`|Owner/Staff·조건|기존 RPC 존재·계약 불일치|`ordering_v2_command` 결제 동작 존재 가능, attempt FK·POST RPC 미확인|수동확인 운영정책·원장 중복 방지|P0|
|API-19|승인|POST `/approvals`|Owner/Staff|기존 RPC 존재·계약 검증 필요|`ordering_request_approval` DB 함수 존재|action allowlist·evidence·version|P0|
|API-20|승인|POST `/approvals/{id}/decide`|Owner|기존 RPC 존재·계약 검증 필요|`ordering_decide_approval` DB 함수 존재|Owner 재검증·동시성|P0|
|API-21|환급|POST `/refunds/confirm`|Owner|기존 RPC 존재·계약 불일치|`ordering_v2_refund_confirm` 존재; 외부 완료 증빙 결합 미확인|원결제 상한·외부 완료 증빙|P0|
|API-22|예외|POST `/exceptions/{id}/resolve`|Owner/Staff·정책|미구현/미확인|예외 테이블 설계 초안|waiver 제한·종결 차단|P1|
|API-23|종결|POST `/orders/{id}/close-requests`|Owner/Staff|SQL 초안·미배포|`ordering_v23_request_close` V2.3 SQL 작성, DB 함수 목록에 없음|버전 동기화·격리 실행|P0|
|API-24|종결|POST `/internal/orders/{id}/execute-close`|서버 내부|미구현/미확인|원자적 종결 RPC 없음|전수 불변식·잠금·감사|P0|
|API-25|감사|GET `/audit`|Owner|미구현/미확인|감사 원장 테이블 존재, 최소 조회 API 미확인|민감정보 마스킹·커서|P1|

> API 번호는 본 현황표의 관리 ID이며, V2.2 문서의 API-01~12 문제점 번호와 다름.

## B. 기존 DB에서 확인한 공개 스키마 함수 (읽기 전용 조회)

|함수|DB 존재|authenticated EXECUTE|SECURITY DEFINER|판정|
|---|---|---|---|---|
|`ordering_v2_command`|예|예|예|기존 업무 진입점; V2.2 계약 준수 미검증|
|`ordering_v2_command_internal`|예|아니오|예|내부 함수; 직접 노출 여부 재검증|
|`ordering_request_approval`|예|예|예|승인 요청; action별 구현 확인 필요|
|`ordering_decide_approval`|예|예|예|승인 결정; Owner·동시성 재검증 필요|
|`ordering_v2_refund_confirm`|예|예|예|환급 확인; 외부 완료 증빙 요건 미충족 가능|
|`ordering_v2_transfer_bucket`|예|아니오|예|내부 버킷 이동; 8버킷 상태 전이 검증 필요|
|`ordering_p0_command`|예|아니오|예|구형 명령; 레거시 영향 분석|
|`ordering_guard_ledger_write`|예|아니오|예|원장 보호 트리거 함수|
|`ordering_check_lot_conservation`|예|아니오|예|로트 수량 보존 트리거 함수|
|`ordering_block_completed_refund`|예|아니오|예|완료 주문 환급 임시 차단|
|`ordering_v23_request_close`|**아니오**|해당 없음|해당 없음|파일 작성만 완료|

**주의:** EXECUTE 가능 여부는 `has_function_privilege`로 확인한 결과다. 실제 JWT를 통한 접근 가능성·업무 성공·안전성까지 보장하지 않는다.

## C. API 구현 게이트

|게이트|완료 조건|현재 상태|
|---|---|---|
|G0 문서/계약|OPDS·ERD·API·RLS 차이 확정|부분 완료|
|G1 격리 DB|기존 DB 복제 및 신규 DDL/FK/RLS 실행|미완료|
|G2 보안 경계|실제 Owner/Staff JWT·비활성·교차 tenant 테스트|미완료|
|G3 주문/발주|생성·확정·PO 전송·입고·수량 검증|미완료|
|G4 재고/인도|예약·배분·해제·인도 원장 대사|미완료|
|G5 결제/환급|수동 사실 확인·원장 반영·외부 환급 완료 증빙|미완료|
|G6 종결|원자적 종결 검사 및 Staff 요청 분리|미완료|
|G7 회귀/승인|기존 19개 테스트+2세션 경쟁+배포 승인|미완료|

## D. Claude Code / Bolt.new 개발 연계

- **Claude Code**: G0~G7의 DB·RPC·RLS·트랜잭션·JWT·회귀 테스트를 구현. 각 API마다 `schema-ready`, `rpc-written`, `isolated-tested`, `jwt-tested`, `integration-tested` 증거를 기록.
- **Bolt.new**: `isolated-tested` 이상이고 API 계약이 확정된 기능만 실제 API에 연결. 나머지는 UI 시안 또는 비활성 상태로 표시하고 성공 응답을 조작하지 않는다.
- **운영 배포**: 보류. 이 문서는 계획 및 실존 여부 현황이지 기능 검수 합격표가 아니다.
