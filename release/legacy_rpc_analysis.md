# 레거시 RPC 영향 분석·전환 계획 (E5, T10)

작성일: 2026-11-25 · 범위: `ordering-dev`의 레거시 RPC(`ordering_v2_command` 등)와 이 저장소의 신규 서버(HTTP API 80개 경로, 마이그레이션 001~024)의 관계.

## 1. 결론

1. **이 저장소의 마이그레이션 001~024는 `ordering-dev`에 그대로 적용할 수 없다.** 레거시 DB에 이미 있는 테이블 5개(`ordering_tenants`, `ordering_members`, `ordering_orders`, `ordering_order_lines`, `ordering_commands`)를 `001`~`003`이 같은 이름으로 `create table` 한다. 열 구성도 다르다(§4).
2. 레거시 RPC는 `authenticated`가 직접 호출하는 `SECURITY DEFINER` 함수이고, 신규 서버는 `service_role`만 쓰는 구조다. **두 쓰기 경로를 같은 테이블에 공존시키면 신규 불변식(가드 트리거)이 우회되거나 레거시 호출이 깨진다.** 공존 기간을 두는 설계는 권하지 않는다(§5).
3. **권고: 깨끗한 별도 Supabase 프로젝트에 신규 스키마를 적용하고, `ordering-dev`는 읽기 전용 참조로 두었다가 폐기**한다(옵션 A, §6). 충돌하는 5개 테이블은 **실제 점검에서 모두 0행**으로 확인되어(§7 #10) 이 5개 테이블에는 이관 비용이 없다. 나머지 레거시 테이블의 행 수는 아직 확인하지 않았다.
4. 레거시 RPC에는 어떤 변경도 하지 않는다(`REVOKE`·`DROP` 포함). 정리(Contract) 단계는 별도 승인과 백업 뒤에만 한다(`release/rollback_plan.md`).

## 2. 방법과 한계

| 항목 | 내용 |
|---|---|
| 한 일 | 저장소 문서(`Files_init/Ordering_Auth_RPC_통합검증_결과_V1.0.md`, `Ordering_보안_비판적재검토_V1.0.md`, `BookFlow_Ordering_DB_ERD_V2_설계서.md`, `Docs/05_API_Security/BookFlow_Ordering_API_구현현황표_V1.0.md`)와 신규 마이그레이션·권한 모델·HTTP 경로표를 대조했다 |
| **하지 않은 일** | **`ordering-dev`에 접속하지 않았다.** E1 승인(2026-11-24)은 로컬 격리 DB에 한정되고 `ordering-dev` 적용·조회는 별도 승인이 필요하다. 레거시 함수의 **정의(SQL 본문)는 저장소에 없다** |
| 한계 | 아래 레거시 사실은 모두 문서에서 읽은 것이다. 열 단위 차이·실제 제약·트리거·권한은 §7의 읽기 전용 SQL로 확인 전까지 **미확인**이다 |
| 변경한 것 | 이 저장소의 문서·점검 SQL·테스트뿐이다. DB·RPC·RLS·운영 환경 변경은 없다 |

## 3. 레거시 인벤토리 (구현현황표 §B, 2026-11-22 읽기 전용 조회 기준)

| 함수 | `authenticated` 실행 | 역할 | 신규 서버에서의 위치 |
|---|---|---|---|
| `ordering_v2_command` | **예**(SECURITY DEFINER) | 업무 진입점. action: `create`, `po`, `receipt`, `allocation`, `notice`, `payment`, `handover`, `complete` | 아래 §3.1 대응표 |
| `ordering_v2_command_internal` | 아니오 | 내부 함수 | 대응 없음(내부 구현) |
| `ordering_request_approval` | 예 | 승인 요청(`REFUND_CONFIRM` 등, action별 구현 미확인) | `POST /refund-tasks/{id}/refund-requests` 등 도메인별 명령 |
| `ordering_decide_approval` | 예 | Owner 승인 결정 | `POST /refund-requests/{id}/decision` 등 |
| `ordering_v2_refund_confirm` | 예 | 환급 확인 | 환급 확인은 승인 결정 안에서 실행(`confirmRefund`, Owner 전용) |
| `ordering_v2_transfer_bucket` | 아니오 | 8버킷 이동 | 8버킷 프로젝션 대신 배분·해제·인도·편입·반품 원장(§5 R6) |
| `ordering_p0_command` | 아니오(철회됨) | 구형 명령 | 대응 없음. 이미 막힘 |
| `ordering_guard_ledger_write`, `ordering_check_lot_conservation`, `ordering_block_completed_refund` | 아니오 | 원장 보호 트리거 | 신규 가드 트리거와 주문 재개 명령으로 대체 |
| `ordering_v23_request_close` | **아니오**(2026-11-25 점검, 사용자 보고). DB에는 있음(문서 11-22는 "없음") | 종결 요청 RPC. **`authenticated`에 노출되지 않는다.** 정의·`SECURITY DEFINER` 여부·`service_role` 실행 권한은 미확인(#1 다른 열, #2 필요) | 종결은 `POST /orders/{id}/closure-requests` + 서버 종결 스위퍼 |

### 3.1 `ordering_v2_command` action → 신규 경로

| 레거시 action | 신규 경로(서점 범위 `/v1/tenants/{tenantId}`) | 차이 |
|---|---|---|
| `create` | `POST /orders`, `POST /orders/{id}/confirm` | 신규는 다품목·버전·서점별 표시번호·멱등 키 |
| `po` | `POST /orders/{id}/lines/{lineId}/sourcing-allocations`, `POST /purchase-orders`, `…/ready`, `…/delivery`, `…/supplier-replies` | 신규는 조달 배정 → 발주 N:M, 외부 전달 사실 기록 |
| `receipt` | `POST /purchase-orders/{id}/receipts`, `POST /receipts/{id}/corrections` 등 | 신규는 검수·불량·초과 분리, 발주 품목별 입고 상한 |
| `allocation` | `POST /receipts/{id}/allocations`, `…/allocations/{id}/releases`·`cancellations`·`reallocations` | 신규는 고객별 로트 귀속(8버킷에 없던 FK) |
| `notice` | `POST /orders/{id}/notification-targets`, `…/attempts`, `…/result` | 신규는 시도·복사·결과·재안내를 구분 |
| `payment` | `POST /orders/{id}/payments`, `POST /payments/{id}/confirmation` | 신규는 기록과 증빙 확인 분리, 직원 수기 확인임을 명시 |
| `handover` | `POST /orders/{id}/fulfillments` | 신규는 재고·입고분 출처 선택, 인도 정정 |
| `complete` | `POST /orders/{id}/closure-requests` | 신규는 다품목·공급처 의무·처분·예외를 모두 검사 |
| (승인·환급) | `refund-tasks`, `refund-requests`, `refund-attempts`, `…/decision` | 환급 승인은 Owner 전용 유지 |

대응하지 못한 레거시 기능은 확인되지 않았다. 반대로 **신규에만 있는 기능**(취소·반품·정정·재개·공급처·직원 초대·감사 로그)은 레거시에 대응이 없다.

## 4. 테이블 충돌 (확인된 것과 미확인인 것)

레거시 "기존" 15개 테이블(ERD 설계서 §4) 중 신규 마이그레이션이 **같은 이름으로 생성하는 것은 5개**다. 이름이 겹치지 않는 나머지 레거시 테이블은 신규 서버가 읽지도 쓰지도 않는다.

| 테이블 | 레거시(문서) | 신규(마이그레이션) | 영향 |
|---|---|---|---|
| `ordering_tenants` | `id`, `name` | + `status`(ACTIVE만), `owner_user_id` **not null**, `created_at` | `create table` 실패. 기존 행이 있으면 `owner_user_id`를 채울 값이 없다 |
| `ordering_members` | `(tenant_id, user_id)` PK, `role`, `active` | 같은 형태 + `created_at`, 마지막 Owner 보호 트리거 | 구조는 비슷하나 `create table` 실패. 레거시 멤버 UUID는 **가상 값**(실 `auth.users` 아님) |
| `ordering_orders` | `order_number`, `status`, `version`, `confirmed_at`, `closed_at`, `customer_id`(확장 제안) | `display_number`, `status ∈ {DRAFT, CONFIRMED}`, `total_krw`, `cancelled_at` | 이름·상태 모델이 다르다. 레거시의 완료/인도 상태 값 집합은 **미확인** |
| `ordering_order_lines` | `ordered_qty`, `cancelled_qty`, `unit_price_krw`, `version` | `quantity`, `position`, 도서 스냅샷 열, 확정 뒤 불변 트리거 | 수량 의미가 다르다(신규는 취소 적용 시 주문 수량을 제자리에서 줄이는 승인된 해석을 쓴다). 레거시 열은 ERD 설계서에서 '기존/확장'으로 표시되어 일부는 제안일 수 있다 |
| `ordering_commands` | PK `(tenant_id, command_key)`, `payload_hash`, `result` | PK `(tenant_id, operation, command_key)` | 키 구조가 달라 같은 키가 다른 명령에 재사용될 수 있다 |

**미확인(점검 필요):** 열의 실제 타입·널 허용, 제약·트리거 이름, `private` 스키마에 같은 이름의 함수가 있는지(`private.is_ordering_member`, `private.forbid_mutation`, `private.protect_last_owner`는 신규가 `create function` 한다), 확장(`pgcrypto`·`gen_random_uuid`), 테이블별 행 수.

## 5. 위험 분석

| # | 위험 | 근거 | 심각도 | 대응 |
|---|---|---|---|---|
| R1 | 마이그레이션 적용 실패·부분 적용 | §4의 테이블 5개 충돌, 함수 이름 충돌 가능성 | 높음 | 같은 프로젝트에 적용하지 않는다(옵션 A) |
| R2 | 두 쓰기 경로의 공존 | 레거시는 `authenticated`가 RPC로 쓰고, 신규는 `service_role`만 쓰며 `authenticated`는 SELECT뿐. 같은 테이블에 두 경로가 있으면 신규 가드(예약 합계 ≤ 보유 재고, 확정 주문 불변, 추가 전용 원장)에 레거시 쓰기가 막히거나, 레거시가 신규 불변식을 모르는 상태로 값을 바꾼다 | 높음 | 같은 테이블을 공유하지 않는다 |
| R3 | 클라이언트 전환 | 레거시는 `supabase.rpc('ordering_v2_command', …)`를 프런트에서 직접 호출. 신규는 별도 백엔드의 HTTP API(`/v1/...`, Bearer JWT) | 중간 | 프런트의 호출 계층을 HTTP 클라이언트로 교체. 신규 OpenAPI가 계약 |
| R4 | 권한 정책 불일치 | 레거시는 Staff의 `payment`·`complete`를 일률 차단(`보안 비판적재검토` P0-1). 신규는 OPDS V1.1대로 Staff가 결제 기록·확인·종결 요청 가능, 환급 승인·정정은 Owner 전용 | 중간 | 신규 정책이 승인된 문서에 맞다. 전환 시 직원 권한이 **넓어진다**는 점을 알린다 |
| R5 | 레거시 정상 경로의 협소함 | 단일 품목 정상 경로만(문서 §미완료 3): 부분 입고·다중 로트·취소·환급·정정·동시성 미구현 | 낮음 | 신규가 이를 모두 포함. 레거시로 되돌릴 이유가 없다 |
| R6 | 데이터 모델 재설계 | 레거시 `receipt_lots`/`receipt_dispositions`(8버킷 잔액 프로젝션) ↔ 신규 `goods_receipts`/`receipt_allocations`/해제·인도·취소·편입·반품 원장(잔량은 파생). 1:1 변환이 아니다 | 중간 | 이관이 필요한 데이터가 있을 때만 변환 스크립트를 쓴다. 개발 테스트 데이터면 폐기 |
| R7 | 데이터 이관 범위 | 문서에는 개발용 가상 UUID·단일 주문 검증 데이터가 있다고 기록되었으나, **2026-11-25 점검에서 충돌하는 5개 테이블이 모두 0행**(사용자 보고). 나머지 레거시 테이블(`ordering_receipt_lots`, `ordering_payment_ledger`, `ordering_audit_ledger` 등)의 행 수는 미보고 | **낮음(5개 테이블은 확인됨)** | 5개 테이블은 이관할 데이터가 없다. 나머지 테이블의 행 수는 #10 전체 결과로 확인한다. 모두 0이면 이관 단계(백필)를 두지 않는다 |
| R8 | `SECURITY DEFINER` 노출 | Security Advisor 경고 1건, 유출 비밀번호 보호 비활성 경고 | 중간 | 신규 경로로 전환한 뒤 레거시 RPC의 `authenticated` EXECUTE를 철회한다. **`REVOKE`는 파괴적이므로 별도 승인** |
| R9 | 감사 이력 | 레거시 `ordering_audit_ledger` ↔ 신규 `ordering_audit_log`는 별개 모델 | 낮음 | 이관하지 않고 레거시를 보존 기간 동안 읽기 전용으로 둔다(D29 미결정) |

## 6. 전환 옵션과 권고

| 옵션 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **A. 새 Supabase 프로젝트(권고)** | 깨끗한 프로젝트에 001~024 + 신규 서버를 적용. `ordering-dev`는 읽기 전용으로 보관 후 폐기 | 이름 충돌 0, 두 경로 공존 없음, 롤백은 "새 프로젝트를 쓰지 않는다"로 끝, Auth 사용자도 실계정으로 새로 시작(레거시의 가상 UUID 문제 해소) | 새 프로젝트가 필요하다(비용·승인). 레거시 데이터는 자동 이관되지 않는다 |
| B. 같은 프로젝트, 새 DB 스키마 | 테이블을 `ordering_v3` 같은 별도 스키마에 만든다 | 한 프로젝트 유지 | 마이그레이션·서버 쿼리가 `public.` 이름을 쓰므로 광범위한 변경(코드·테스트 전반). RLS·권한도 다시 설계 |
| C. 같은 프로젝트, 테이블 이름 변경 | 신규 테이블에 접두를 바꿔 충돌 회피 | 한 프로젝트 유지 | B와 같은 규모의 변경, 의미 없는 이름 분기 |
| D. 레거시 테이블 확장(in-place) | 레거시 테이블에 `ALTER`로 열을 더해 병합 | 이관 없음 | 상태 모델·수량 의미가 달라 안전한 병합 불가. 공존(R2)이 그대로 남는다. **비권고** |
| E. 같은 프로젝트, 빈 충돌 테이블 교체 | 5개 테이블이 비어 있으므로 레거시 RPC·트리거와 함께 `DROP`하고 신규 마이그레이션을 적용 | 한 프로젝트 유지, 이관 없음 | **파괴적**(레거시 RPC 11개가 깨진다. 롤백은 백업 복원뿐). 나머지 레거시 테이블·함수·정책이 신규와 충돌하는지 #3~#9로 확인해야 한다. E5-4(파괴적 작업 승인)와 같은 승인이 필요하다. 0행이라는 사실만으로는 안전하지 않다 |

**권고는 A**다. 5개 테이블이 비어 있다는 점(§7 #10)은 옵션 E를 현실적인 대안으로 만들지만, E는 레거시 RPC를 파괴하는 되돌릴 수 없는 작업이라 A를 바꿀 이유가 되지는 않는다. 새 프로젝트를 만들 수 없을 때의 차선책으로 본다. 전환 단계(확장 → 백필 → 검증 → 전환 → 정리)에 맞추면 다음과 같다.

| 단계 | 할 일 | 롤백 |
|---|---|---|
| 0. 점검 | §7의 읽기 전용 SQL을 승인 뒤 `ordering-dev`에서 실행해 §4의 미확인 항목과 행 수를 채운다 | 없음(읽기 전용) |
| 1. 확장 | 새 프로젝트에 001~024 적용, Auth의 이메일 확인 활성화, 서버 환경 변수(`DATABASE_URL`, JWT 키, `CORS_ALLOWED_ORIGINS`) 설정 | 새 프로젝트를 쓰지 않는다 |
| 2. 백필 | 이관할 데이터가 있을 때만(R7). 없으면 건너뛴다 | 새 프로젝트 데이터 폐기 |
| 3. 검증 | G1~G7: 격리 DB 검증은 끝났으므로 실제 Supabase에서 실 Auth 계정 2개로 JWT·HTTP·RLS·동시성 재검증(T1~T3, T6) | 전환하지 않는다 |
| 4. 전환 | 프런트를 HTTP 클라이언트로 바꾸고 새 API를 가리킨다. 레거시는 끄지 않는다 | 프런트 라우팅을 레거시로 되돌린다 |
| 5. 정리 | 레거시 RPC의 `authenticated` EXECUTE 철회, 프로젝트 보관·폐기 | **롤백이 아니라 백업 복원에 의존**. 별도 승인 |

## 7. 읽기 전용 점검 (승인 필요, 미실행)

`release/legacy_readonly_inspection.sql`은 SELECT만 있는 점검 SQL이다(`tests/release/legacyInspection.test.ts`가 모든 문장이 SELECT/WITH이고 변경·권한·세션 변경 키워드가 없음을 확인하며, 격리 DB에서 읽기 전용 트랜잭션으로 오류 없이 실행됨을 확인했다). 이 저장소의 코드는 이 파일을 어떤 DB에도 실행하지 않는다. **사용자가 승인하면 사람이 `ordering-dev`에서 실행**하고 결과를 아래에 붙인다.

| 점검 | 확인할 것 | 판정에 쓰는 법 |
|---|---|---|
| #1~#2 함수 목록·정의 | 문서의 11개 함수가 실제로 같은지, `SECURITY DEFINER`·`search_path` 설정, 정의의 오류 코드·분기 | R4·R8, 대응표(§3.1)의 정확성 |
| #3~#5 열·제약·트리거 | §4의 5개 테이블 열 차이, 레거시 트리거 이름 | R1·R2 |
| #6~#8 RLS·정책·권한 | `authenticated`의 직접 DML 가능 여부 | R2·R8 |
| #9 `private` 스키마 | 이름 충돌하는 함수 | R1 |
| #10 테이블별 행 수 | 운영 데이터 유무 | **R7: 행이 개발 데이터뿐이면 옵션 A에서 이관 불필요** |
| #11~#12 확장·버전 | `pgcrypto`·`gen_random_uuid`, 서버 버전 | 마이그레이션 호환 |

결과 붙여넣기: **진행 중**. 결과는 사용자가 SQL Editor에서 실행해 직접 알려 주는 방식이다(이 환경에는 DB 접속 수단이 없다). **사용자가 보고한 사실만 적고, 보고되지 않은 항목은 비워 둔다.**

| 점검 | 상태 | 보고된 사실(출처: 사용자, 2026-11-25) |
|---|---|---|
| #1 함수 목록 | **부분** | 총 **11행**. 문서의 11개 함수가 모두 있고 문서에 없는 다른 `ordering%` 함수는 **없다**. `ordering_v23_request_close`는 **이제 DB에 있다**(문서 11-22에는 없음 → 그 이후 배포). **`authenticated` 실행 가능은 정확히 4개**: `ordering_v2_command`, `ordering_request_approval`, `ordering_decide_approval`, `ordering_v2_refund_confirm` — **문서와 같다.** `ordering_v23_request_close`를 포함한 나머지 7개는 `authenticated` 실행 **불가**. `security_definer`·소유자·`function_settings`(`search_path` 고정 여부)·`anon`·`service_role` 실행 권한은 **미보고** |
| #2 함수 정의 | 미실행 | — |
| #3 열 | 미실행 | — |
| #4 제약 | 미실행 | — |
| #5 트리거 | 미실행 | — |
| #6 RLS 사용 여부 | 미실행 | — |
| #7 정책 | 미실행 | — |
| #8 테이블 권한 | 미실행 | — |
| #9 `private` 스키마 | 미실행 | — |
| #10 테이블별 행 수 | **부분** | 이름이 겹치는 5개 테이블이 **모두 0행**: `ordering_tenants` 0, `ordering_members` 0, `ordering_orders` 0, `ordering_order_lines` 0, `ordering_commands` 0. 나머지 `ordering%` 테이블의 행 수는 **미보고** |
| #11~#12 확장·서버 버전 | 미실행 | — |

**#1에서 얻은 판단:** (1) 레거시 RPC 목록과 `authenticated` 노출 범위(4개)는 문서 그대로이므로 §3 인벤토리·§3.1 대응표·R8(노출된 `SECURITY DEFINER` 함수 4개)은 그대로 유효하다. (2) 배포된 `ordering_v23_request_close`는 `authenticated`에 노출되지 않으므로 **클라이언트가 직접 호출할 수 없고**, 종결 RPC 노출에 따른 위험(R4·R8의 종결 부분)은 커지지 않았다. 다만 이 함수가 어떤 경로(서버 전용? 다른 RPC 내부?)로 호출되는지, 정의가 종결 불변식을 얼마나 검사하는지는 #2가 있어야 안다. (3) 문서가 11-22 이후 갱신되지 않았으므로 나머지 레거시 사실(§4의 열 구성 등)은 문서가 아니라 점검 결과로 확정해야 한다. (4) `anon` 실행 권한이 보고되지 않았으므로 "비로그인이 호출할 수 있는 함수가 없다"는 결론은 아직 내릴 수 없다.

## 8. 결정 요청

| 번호 | 결정 | 권고 | 결정란 |
|---|---|---|---|
| E5-1 | `ordering-dev` **읽기 전용 점검**(§7의 SQL, 변경 없음) 실행 승인 | 승인 | [ ] 승인 [ ] 보류 |
| E5-2 | 전환 방식 | **A. 새 Supabase 프로젝트** | [ ] A [ ] B [ ] C [ ] 다른 방안: ______ |
| E5-3 | 새 프로젝트 생성(비용·관리 주체) | E5-2가 A일 때 필요 | [ ] 승인 [ ] 보류 |
| E5-4 | 레거시 RPC의 `authenticated` EXECUTE 철회와 `ordering-dev` 폐기 시점(파괴적, 백업 뒤) | 신규 경로 검증·전환 이후 | [ ] 시점: ______ |
