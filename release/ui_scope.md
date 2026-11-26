# 웹 UI 범위 결정서 (2026-11-26)

이 저장소는 **백엔드(API·DB·검증)** 다. 프로젝트 문서(`BookFlow_Ordering_BoltNew_단계별프롬프트_V1.0/README.md`)가 책임을 나눈다: *Claude Code = DB/RLS/업무 API·검증, Bolt.new = 반응형 웹 UI·업무 흐름·검증된 API 연결.* 이 결정서는 그 분담에 따라 **UI에서 무엇을 실제 API에 연결하고, 무엇을 데모·비활성으로 두며, 백엔드가 UI를 위해 무엇을 더 만들어야 하는지**를 정한다.

## 1. 결정

1. **UI는 이 저장소에 만들지 않는다.** 웹 UI(React + TypeScript + Tailwind, Supabase Auth)는 Bolt.new 단계별 프롬프트로 별도 프로젝트에서 만든다. 이 저장소가 UI에 주는 것은 *검증된 API 계약*과 *증거*다.
2. **UI 1차 범위는 "지금 서버가 검증한 API로 완결되는 P0 흐름"** 으로 한정한다(§2). 서버가 없는 화면은 `DEMO MODE`·비활성으로 표시하고 성공 처리하지 않는다.
3. **백엔드는 UI가 막히는 조회 API부터 보강한다**(§4). 현재 API는 *쓰기 명령*은 거의 다 있으나 화면의 *목록·큐·집계 조회*가 부족하다.
4. **미승인 정책은 활성화하지 않는다**: DEC-08(확정 후 가격/품목 변경, ST-O04)은 서버에서 막혀 있고(`tests/db/confirmedOrderChangeBlocked.test.ts`) UI도 `승인 필요`로 비활성 표시한다. DEC-01/12/15/16, D22~26/29의 구체 행위도 같다.
5. **실제 Supabase 환경 연결은 범위 밖이다**(사용자 결정). UI는 이 저장소의 서버(`server/main.ts`)와 격리 DB를 대상으로 개발·검증하고, 운영 배포는 보류한다.

## 2. UI 1차 범위: 실제 API에 연결할 수 있는 화면

서버 근거는 `tests/db`·`tests/openapi`(격리 Postgres, 실제 서명 JWT, 전 경로 계약·권한·롤백 검증, 전체 202개 파일 1604개 테스트 통과)다. 계약은 `openapi/ordering.yaml`(주문 4)과 `openapi/ordering-http.yaml`(나머지, 총 83개 연산)이며 **미검증 엔드포인트는 호출하지 않는다**.

| Bolt 단계 | 화면 | 실제 API 연결 | 비고 |
|---|---|---|---|
| 02 인증 | A-04 서점 개설, A-05 서점 선택, A-06 초대 수락 | `POST /v1/stores`, `GET /v1/me/memberships`, `POST /v1/invitations/accept` | 로그인·회원가입·비밀번호·이메일 인증(A-01~03, 07)은 Supabase Auth가 담당(서버 API 없음) |
| 04 도서 | B-01 YES24 검색, B-02~05 도서 목록·상세·수기 등록·수정·이력 | `GET /book-search`(YES24 검색, 503이면 수기 등록으로 전환), `GET /integrations/yes24`(S-08), `GET/POST /books`(검색 결과 선택 = `source:"YES24"` 등록), `GET /books/{id}`, `/updates`, `GET /books/{id}/revisions` | **실제 YES24 API는 미확인**(공개 문서 없음) — 서버는 게이트웨이 계약을 가정한다(보고서 §113). 고객 C-01~04는 아래 고객 항목 참조 |
| 05 주문 | O-02 목록, O-03 신규, O-04 상세, 확정, **보류·재개·폐기** | `GET/POST /orders`, `GET /orders/{id}`, `/confirm`, `/hold`, `/resume`, `/discard`, `GET /orders/{id}/history` | 목록은 폐기 초안 기본 제외(`includeDiscarded`), 커서 페이지네이션, 상태 `DRAFT`/`CONFIRMED` + 보류·폐기는 필드(`heldAt`·`discardedAt`)로 표시. 고객 선택은 서버 없음 |
| 06 조달·발주 | O-04-02 조달 배정, O-05 공급처, O-06 발주 현황·작성·전달·회신 | `POST /orders/{id}/lines/{id}/sourcing-allocations`, `/sourcing-allocations/{id}/releases`, `/suppliers*`, `/purchase-orders*`, `/supplier-replies`, 취소 요청·응답·확정, 중복 위험 승인 | 공급처·발주 목록·상세 조회 있음 |
| 07 입고·재고 | O-07 입고 현황, O-07-01 입고, O-07-02 배분, I-01 재고 | `POST /purchase-orders/{id}/receipts`, `/receipts/{id}/allocations`·`/defect-resolutions`·`/excess-decisions`·`/corrections`, `/allocations/{id}/cancellations`·`/reallocations`·`/releases`, `GET /receipts`, `GET /receipts/{id}`, `GET /stock`, `GET /stock/{bookId}`, 초기 재고·조정 | 입고 현황·상세 조회 있음 |
| 08 안내·수령·결제 | O-08-01 안내, O-09-01 수령, O-09-02 결제 | `/orders/{id}/notification-targets`(GET/POST), `/notification-targets/{id}/copies`·`/attempts`·`/renotices`, `/notification-attempts/{id}/result`, `GET /message-templates`, `/orders/{id}/fulfillments`(+정정), `/orders/{id}/payments`(GET/POST), `/payments/{id}/confirmation`·`/void`·`/corrections` | 복사·공유는 발송 완료가 아니다(서버도 결과 기록을 분리) |
| 09 취소·반품·환급·정정 | O-04-01 취소, R-01 처분, R-03 반품, R-04 재고 편입, O-09-04 환급, R-05 정정 | `/orders/{id}/cancellation-requests`, `/order-cancellation-requests/{id}/decision`·`/application`, `/allocation-cancellations/{id}/return-requests`·`/stock-intakes`, `/return-requests/{id}/*`, `/return-exceptions/{id}/resolutions`, `/orders/{id}/refund-tasks`, `/refund-tasks/{id}/*`, `/refund-requests/{id}/decision`, `/refund-attempts/{id}/resolution`, `/orders/{id}/closure-requests` | 종결 실행·재개는 서버 내부(스위퍼), UI 경로 없음 |
| 10 설정 | S-01 서점 기본정보, S-07 미수령 경고일, S-02 직원 목록·초대·비활성, 안내 템플릿 버전, 감사 이력 | `GET /store`, `POST /store/settings`, `GET /members`, `POST /members/{id}/delegations`, `GET /delegations`, `GET/POST /staff-invitations`, `POST /staff-invitations/{id}/revocation`, `POST /members/{id}/status`, `GET/POST /message-templates`, `GET /audit-log` | 위임 부여는 서버 없음(§4). 직원은 이름·이메일 없이 사용자 ID로 식별된다 |
| 03 대시보드 | O-01 숫자 카드, O-01-01 예외 큐, O-01-02 장기 미수령 경고 | `GET /dashboard`, `GET /exceptions`, `GET /long-unreceived-warnings` | (통계는 `GET /statistics/hourly` — 일/주/월 추이는 없다.) 예외 큐에 장기 미수령은 포함되지 않는다(별도 목록) |

**공통 규칙(UI가 지킬 서버 계약):** Bearer JWT; 모든 POST에 `Idempotency-Key`; 낡은 `expectedVersion`은 409 `VERSION_CONFLICT`; 같은 키·다른 본문은 409 `IDEMPOTENCY_CONFLICT`; 업무 규칙 위반 422 `BUSINESS_INVARIANT`; 본문 413(기본 1 MiB); 쿼리 시간 초과·내부 오류는 500(재시도 구분 없음); 금액은 정수 문자열; 시각은 RFC3339 UTC(미래 불가); 행위자·역할은 토큰에서만(본문으로 보낼 수 없음); 다른 서점·없는 대상은 같은 404.

## 3. 데모·비활성으로 둘 화면 (서버 없음)

- **고객(C-01~04)**: 1차판 서버 있음(`GET/POST /customers`, `GET /customers/{id}`, `/updates`, `/anonymization`(Owner), `GET /customers/{id}/changes`; 이름+번호 최소 수집, 정책은 `customer_module_decisions.md`). 주문 연결은 `POST/GET /orders/{id}/customer`(선택, 주문은 고객 없이도 만들어진다), 안내 대기열(`GET /notification-targets`) 항목에 `customer`(이름·번호)가 실린다. 주문 목록·상세 응답에는 고객이 없다.
- **YES24 도서 검색(B-01)**: 서버 연동은 있으나 **실제 YES24 API 확인 전**이다(보고서 §113). 설정이 없거나 장애면 503 → 수기 등록.
- **ST-O04 확정 후 가격/품목 변경, 고객 동의(DEC-08)**: 정책 미승인.
- **공개 고객 주문(P1), 택배(D23), PG/VAN(P2), 모바일 M1~M3**: 범위 밖.
- S-09 내보내기: 서버 없음. (S-08 YES24 상태는 `GET /integrations/yes24`로 있다.) (S-01 서점 기본정보와 S-07 미수령 경고일은 `GET /store`·`POST /store/settings`로 구현됨 — 보고서 §108. 서점 중지·해지·소유자 이전은 없다.)

## 4. 백엔드 보강 목록 (UI 막힘 순)

UI 단계 순서에 맞춰 서버가 먼저 만들 조회 API다. 모두 같은 규칙(활성 멤버십 RLS, 커서 페이지네이션, 개인정보 최소화, 계약 테스트)을 따른다.

| 순서 | 막히는 화면 | 보강 | 크기 |
|---|---|---|---|
| 1 | A-05 서점 선택, 앱 셸 | ✅ **완료(2026-11-26)** `GET /v1/me/memberships`: 내가 활성 멤버인 서점·이름·내 역할. 보고서 §99 | 소 |
| 2 | S-02 직원 관리 | ✅ **완료(2026-11-26)** `GET /members`(구성원·역할·활성·합류일), `GET /staff-invitations`(PENDING/ACCEPTED/REVOKED/EXPIRED, 토큰 없음). Owner만. 보고서 §100 | 소 |
| 3 | O-01 대시보드, O-01-01 예외 큐 | ✅ **완료(2026-11-26, 정의 가능한 범위)** `GET /dashboard`: 주문·활성 발주·환급·안내·미결제·미배분 입고·**부분입고 잔량·취소 후속(처분 대기)**·장기 미수령 건수·`since` 이후 접수 주문. `GET /exceptions`: 예외 업무 큐(초과 입고·미확인 결제·환급 필요·안내 실패·발주 취소 미응답, 읽기 전용). 발주 지연(전달 후 `delayDays`일, 가정 — 보고서 §110). 공급처별 현황 `GET /supplier-overview`(보고서 §111). 시간대별 기간 통계 `GET /statistics/hourly`(09~22시 1시간 간격, 기초 단위 합계 — 보고서 §112). 보고서 §101·§107 | 중 |
| 4 | O-07 입고 현황, O-07-02 배분 | ✅ **완료(2026-11-26)** `GET /receipts`(최신순·커서·`unallocated`·`purchaseOrderId` 필터, 배분·미배분 수량), `GET /receipts/{id}`(배분·해제·정정·불량·초과 이력). 보고서 §102. 반품·처분 대기는 6번 | 중 |
| 5 | O-08 안내 대기, O-09 수령·결제 현황 | ✅ **완료(2026-11-26)** `GET /notification-targets`(서점 전체 큐, 파생 상태·필터), `GET /order-settlements`(결제 요약·수령 수량, `unpaid`/`undelivered` 필터). 보고서 §103 | 중 |
| 6 | O-09-04 환급, R-01·R-03·R-04 | ✅ **완료(2026-11-26)** `GET /refund-tasks`(파생 상태·남은 금액·미결 요청·미해소 시도), `GET /allocation-cancellations`(취소 물량의 처분 대기·편입·반품 보관·출고·완료 수량). 보고서 §104 | 중 |
| 7 | S-03 권한 | ✅ **완료(2026-11-26)** `POST /members/{id}/delegations`(MANAGEMENT·STOCK_ADJUSTMENT 부여·회수, Owner만), `GET /delegations`. 변경 이력 테이블(추가 전용). 역할 변경(직원→Owner)은 서버 없음. 보고서 §105 | 중 |
| 8 | O-02 검색 | ✅ **완료(2026-11-26)** `GET /orders?search=`(표시번호 정확 일치·도서명 부분 일치·ISBN 정확 일치, SQL 한 페이지분만 읽음). 고객 검색은 고객 모듈 없음. 보고서 §106 | 소 |

고객 모듈(C-01~04)과 YES24 연동은 PRD 결정이 필요해 이 목록에 넣지 않았다.

## 5. 인수 기준 (UI 1차)

- §2의 화면이 **격리 서버·격리 DB**에서 정상·오류(401/403/404/409/422/413/500)·권한 없음·로딩·빈 결과·중복 클릭(멱등)·버전 충돌·새로고침 시나리오를 통과한다.
- 360/768/1280px, 키보드·스크린리더 접근성, 느린 네트워크·API 장애.
- 미구현·미승인 기능은 `DEMO MODE`/`승인 필요`로 구분되고 성공 처리되지 않는다.
- 다른 서점·비활성 계정의 데이터가 화면에 나오지 않는다(서버가 막지만 UI 회귀 시험으로도 확인).
- 운영 배포는 보류한다.

## 6. 다음 행동

**(이 저장소) §4의 1~8번은 모두 완료됐다(2026-11-26).** 남은 백엔드 일은 다음과 같다. 모두 정책 결정이나 정의가 먼저 필요하다.
1. **대시보드 나머지:** 공급처 회신 ETA를 반영한 발주 지연 정의(현재는 전달 후 경과일), 서점별 시간대·일/주/월 추이 통계(현재 시간대별 합계는 KST 고정). 예외 큐의 담당자 지정·처리 근거(담당 지정 명령 없음)와 유형 추가(정의 필요).
2. **내보내기(S-09):** 서버 없음. PRD 정책 확인 필요. (S-01·S-07 완료, S-08 상태 조회 완료)
3. **고객 모듈(C-01~04):** 1차판 완료(제안안 채택). 남은 것: 연결 해제(필요 시) — `release/customer_module_decisions.md`. **YES24 검색(B-01):** 서버 연동 완료, **실제 YES24 API 계약·이용 권한 확인 필요**(어댑터 한 곳 교체).
4. **직원 역할 변경(직원→Owner):** **하지 않기로 결정(2026-11-26)** — Owner는 서점 개설자뿐이며 직원은 위임(`delegations`)으로만 권한을 받는다. 구현하지 않는다.

**(Bolt.new)** 연결 방법·요청/응답 규칙·오류 처리·호출 레시피는 `Docs/05_API_Security/Bolt_API_연결_가이드_V1.0.md`에 정리했다(엔드포인트 표는 명세에서 생성). `00_공통_실행규칙`과 01~10단계를 이 문서의 §2 표와 `openapi/ordering.yaml`·`openapi/ordering-http.yaml`을 API 연결표로 삼아 진행한다. 대시보드(03)는 §4 3번이 1차 완료라 숫자 카드 일부는 실제 API, 나머지는 데모 값이다.

**낡은 문서:** `Docs/05_API_Security/BookFlow_Ordering_API_구현현황표_V1.0.md`(2026-11-22, "HTTP 라우터 미확인")는 현재 상태와 다르다. UI 연결의 기준은 이 문서와 `openapi/*.yaml`이다(해당 문서 첫머리에 같은 안내를 달았다).
