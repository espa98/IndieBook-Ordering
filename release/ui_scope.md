# 웹 UI 범위 결정서 (2026-11-26)

이 저장소는 **백엔드(API·DB·검증)** 다. 프로젝트 문서(`BookFlow_Ordering_BoltNew_단계별프롬프트_V1.0/README.md`)가 책임을 나눈다: *Claude Code = DB/RLS/업무 API·검증, Bolt.new = 반응형 웹 UI·업무 흐름·검증된 API 연결.* 이 결정서는 그 분담에 따라 **UI에서 무엇을 실제 API에 연결하고, 무엇을 데모·비활성으로 두며, 백엔드가 UI를 위해 무엇을 더 만들어야 하는지**를 정한다.

## 1. 결정

1. **UI는 이 저장소에 만들지 않는다.** 웹 UI(React + TypeScript + Tailwind, Supabase Auth)는 Bolt.new 단계별 프롬프트로 별도 프로젝트에서 만든다. 이 저장소가 UI에 주는 것은 *검증된 API 계약*과 *증거*다.
2. **UI 1차 범위는 "지금 서버가 검증한 API로 완결되는 P0 흐름"** 으로 한정한다(§2). 서버가 없는 화면은 `DEMO MODE`·비활성으로 표시하고 성공 처리하지 않는다.
3. **백엔드는 UI가 막히는 조회 API부터 보강한다**(§4). 현재 API는 *쓰기 명령*은 거의 다 있으나 화면의 *목록·큐·집계 조회*가 부족하다.
4. **미승인 정책은 활성화하지 않는다**: DEC-08(확정 후 가격/품목 변경, ST-O04)은 서버에서 막혀 있고(`tests/db/confirmedOrderChangeBlocked.test.ts`) UI도 `승인 필요`로 비활성 표시한다. DEC-01/12/15/16, D22~26/29의 구체 행위도 같다.
5. **실제 Supabase 환경 연결은 범위 밖이다**(사용자 결정). UI는 이 저장소의 서버(`server/main.ts`)와 격리 DB를 대상으로 개발·검증하고, 운영 배포는 보류한다.

## 2. UI 1차 범위: 실제 API에 연결할 수 있는 화면

서버 근거는 `tests/db`·`tests/openapi`(격리 Postgres, 실제 서명 JWT, 전 경로 계약·권한·롤백 검증, 전체 172개 파일 1500개 테스트 통과)다. 계약은 `openapi/ordering.yaml`(주문 4)과 `openapi/ordering-http.yaml`(나머지, 총 83개 연산)이며 **미검증 엔드포인트는 호출하지 않는다**.

| Bolt 단계 | 화면 | 실제 API 연결 | 비고 |
|---|---|---|---|
| 02 인증 | A-04 서점 개설, A-05 서점 선택, A-06 초대 수락 | `POST /v1/stores`, `GET /v1/me/memberships`, `POST /v1/invitations/accept` | 로그인·회원가입·비밀번호·이메일 인증(A-01~03, 07)은 Supabase Auth가 담당(서버 API 없음) |
| 04 도서 | B-02~05 도서 목록·상세·수기 등록·수정·이력 | `GET/POST /books`, `GET /books/{id}`, `/updates`, `GET /books/{id}/revisions` | YES24 검색(B-01)은 서버 없음 → 비활성 |
| 05 주문 | O-02 목록, O-03 신규, O-04 상세, 확정, **보류·재개·폐기** | `GET/POST /orders`, `GET /orders/{id}`, `/confirm`, `/hold`, `/resume`, `/discard`, `GET /orders/{id}/history` | 목록은 폐기 초안 기본 제외(`includeDiscarded`), 커서 페이지네이션, 상태 `DRAFT`/`CONFIRMED` + 보류·폐기는 필드(`heldAt`·`discardedAt`)로 표시. 고객 선택은 서버 없음 |
| 06 조달·발주 | O-04-02 조달 배정, O-05 공급처, O-06 발주 현황·작성·전달·회신 | `POST /orders/{id}/lines/{id}/sourcing-allocations`, `/sourcing-allocations/{id}/releases`, `/suppliers*`, `/purchase-orders*`, `/supplier-replies`, 취소 요청·응답·확정, 중복 위험 승인 | 공급처·발주 목록·상세 조회 있음 |
| 07 입고·재고 | O-07-01 입고, O-07-02 배분, I-01 재고 | `POST /purchase-orders/{id}/receipts`, `/receipts/{id}/allocations`·`/defect-resolutions`·`/excess-decisions`·`/corrections`, `/allocations/{id}/cancellations`·`/reallocations`·`/releases`, `GET /stock`, `GET /stock/{bookId}`, 초기 재고·조정 | **입고 현황 목록(O-07)** 은 조회 API 없음(§4) |
| 08 안내·수령·결제 | O-08-01 안내, O-09-01 수령, O-09-02 결제 | `/orders/{id}/notification-targets`(GET/POST), `/notification-targets/{id}/copies`·`/attempts`·`/renotices`, `/notification-attempts/{id}/result`, `GET /message-templates`, `/orders/{id}/fulfillments`(+정정), `/orders/{id}/payments`(GET/POST), `/payments/{id}/confirmation`·`/void`·`/corrections` | 복사·공유는 발송 완료가 아니다(서버도 결과 기록을 분리) |
| 09 취소·반품·환급·정정 | O-04-01 취소, R-01 처분, R-03 반품, R-04 재고 편입, O-09-04 환급, R-05 정정 | `/orders/{id}/cancellation-requests`, `/order-cancellation-requests/{id}/decision`·`/application`, `/allocation-cancellations/{id}/return-requests`·`/stock-intakes`, `/return-requests/{id}/*`, `/return-exceptions/{id}/resolutions`, `/orders/{id}/refund-tasks`, `/refund-tasks/{id}/*`, `/refund-requests/{id}/decision`, `/refund-attempts/{id}/resolution`, `/orders/{id}/closure-requests` | 종결 실행·재개는 서버 내부(스위퍼), UI 경로 없음 |
| 10 설정 | S-02 직원 목록·초대·비활성, 안내 템플릿 버전, 감사 이력 | `GET /members`, `GET/POST /staff-invitations`, `POST /staff-invitations/{id}/revocation`, `POST /members/{id}/status`, `GET/POST /message-templates`, `GET /audit-log` | 위임 부여는 서버 없음(§4). 직원은 이름·이메일 없이 사용자 ID로 식별된다 |
| 03 대시보드 | O-01 숫자 카드, O-01-02 장기 미수령 경고 | `GET /dashboard`, `GET /long-unreceived-warnings` | 안내·미결제·입고 잔량 카드와 예외 큐(O-01-01)는 서버 없음 → 데모 값(§4) |

**공통 규칙(UI가 지킬 서버 계약):** Bearer JWT; 모든 POST에 `Idempotency-Key`; 낡은 `expectedVersion`은 409 `VERSION_CONFLICT`; 같은 키·다른 본문은 409 `IDEMPOTENCY_CONFLICT`; 업무 규칙 위반 422 `BUSINESS_INVARIANT`; 본문 413(기본 1 MiB); 쿼리 시간 초과·내부 오류는 500(재시도 구분 없음); 금액은 정수 문자열; 시각은 RFC3339 UTC(미래 불가); 행위자·역할은 토큰에서만(본문으로 보낼 수 없음); 다른 서점·없는 대상은 같은 404.

## 3. 데모·비활성으로 둘 화면 (서버 없음)

- **고객(C-01~04)**: 고객 등록·검색·중복 후보·이력 — 서버 모듈 없음. 주문은 고객 없이 만들 수 있다.
- **YES24 도서 검색(B-01)**: 외부 연동 없음.
- **ST-O04 확정 후 가격/품목 변경, 고객 동의(DEC-08)**: 정책 미승인.
- **공개 고객 주문(P1), 택배(D23), PG/VAN(P2), 모바일 M1~M3**: 범위 밖.
- 직원 관리의 *위임 부여*(Owner가 직원에게 공급처 관리·재고 조정 위임)와 S-01 서점 기본정보 수정·S-08 YES24 상태·S-09 내보내기: 서버 없음.

## 4. 백엔드 보강 목록 (UI 막힘 순)

UI 단계 순서에 맞춰 서버가 먼저 만들 조회 API다. 모두 같은 규칙(활성 멤버십 RLS, 커서 페이지네이션, 개인정보 최소화, 계약 테스트)을 따른다.

| 순서 | 막히는 화면 | 보강 | 크기 |
|---|---|---|---|
| 1 | A-05 서점 선택, 앱 셸 | ✅ **완료(2026-11-26)** `GET /v1/me/memberships`: 내가 활성 멤버인 서점·이름·내 역할. 보고서 §99 | 소 |
| 2 | S-02 직원 관리 | ✅ **완료(2026-11-26)** `GET /members`(구성원·역할·활성·합류일), `GET /staff-invitations`(PENDING/ACCEPTED/REVOKED/EXPIRED, 토큰 없음). Owner만. 보고서 §100 | 소 |
| 3 | O-01 대시보드, O-01-01 예외 큐 | 🟡 **1차 완료(2026-11-26)** `GET /dashboard`: 주문(초안·보류·폐기·확정)·활성 발주·환급 업무·장기 미수령 건수·`since` 이후 접수 주문. **남음**: 안내 대기·실패, 미결제, 미배분 입고·부분입고 잔량, 공급처별 현황, 기간 통계, 예외 큐 목록(O-01-01). 보고서 §101 | 중 |
| 4 | O-07 입고 현황, O-07-02 배분 | 입고·배분·미배분량 목록·상세 조회(`GET /receipts`, `/receipts/{id}`) | 중 |
| 5 | O-08 안내 대기, O-09 수령·결제 현황 | 서점 전체 안내 대기 큐, 수령·결제 현황 목록(지금은 주문별 조회만) | 중 |
| 6 | O-09-04 환급, R-01·R-03·R-04 | 환급 필요 업무 목록, 취소 물량 처분·반품 목록 | 중 |
| 7 | S-03 권한 | 위임 부여·회수 명령과 조회(재고 조정·공급처 관리 위임) | 중 |
| 8 | O-02 검색 | 주문 목록의 표시번호·도서명 검색 필터(지금은 상태만) | 소 |

고객 모듈(C-01~04)과 YES24 연동은 PRD 결정이 필요해 이 목록에 넣지 않았다.

## 5. 인수 기준 (UI 1차)

- §2의 화면이 **격리 서버·격리 DB**에서 정상·오류(401/403/404/409/422/413/500)·권한 없음·로딩·빈 결과·중복 클릭(멱등)·버전 충돌·새로고침 시나리오를 통과한다.
- 360/768/1280px, 키보드·스크린리더 접근성, 느린 네트워크·API 장애.
- 미구현·미승인 기능은 `DEMO MODE`/`승인 필요`로 구분되고 성공 처리되지 않는다.
- 다른 서점·비활성 계정의 데이터가 화면에 나오지 않는다(서버가 막지만 UI 회귀 시험으로도 확인).
- 운영 배포는 보류한다.

## 6. 다음 행동

1. **(이 저장소)** §4 순서대로 조회 API를 TDD로 구현한다. 1·2번(내 서점 목록, 직원·초대 목록)이 가장 작고 UI 1차의 앞단(02·10 단계)을 연다.
2. **(Bolt.new)** `00_공통_실행규칙`과 01~02단계로 앱 셸·인증을 시작하고, 이 문서의 §2 표와 `openapi/*.yaml`을 API 연결표로 쓴다. 03(대시보드)은 §4의 3번이 끝나기 전에는 데모 값으로 둔다.
3. 낡은 `Docs/05_API_Security/BookFlow_Ordering_API_구현현황표_V1.0.md`(2026-11-22, "HTTP 라우터 미확인")는 현재 상태와 다르다. UI 연결의 기준은 이 문서와 `openapi/*.yaml`이다.
