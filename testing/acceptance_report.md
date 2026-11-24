# 통합 인수 보고서 (10단계)

작성일: 2026-11-24 (갱신) · 기준 커밋: `21e22e3bbba75f9351cdff8c05b608847edac3d1` (`main`, 작업 트리 변경 없음 — 이 문서 갱신 전 상태). 최초 10단계 판정은 `4ece379`에서 했고, 그 뒤 P0 도메인 기능 9개 커밋이 추가되어 이 문서를 다시 측정해 갱신했다(§9).
환경: Windows 11, Node v24.18.0, npm 12.0.0, TypeScript 7.0.2, vitest 5.1.1.
상세 항목별 판정은 `testing/test_matrix.csv`에 있다. 이 문서는 요약·증거·한계를 기록한다.

## 0. 최종 판정

| 영역 | 판정 | 한 줄 근거 |
|---|---|---|
| 도메인 단위·통합(메모리 저장소) | **PASS** | `npx vitest run` 113 files / 1132 tests 통과, 실패 0 (DB 테스트 68개 포함) |
| 타입 검사 | **PASS** | `npx tsc --noEmit` 출력 없음 |
| OpenAPI 스키마·계약 | **PARTIAL** | 주문 API(05단계)만 명세가 있고 26개 통과. 나머지 영역은 명세·구현 없음 |
| HTTP | **PARTIAL** | 핸들러 단위 41개 통과. 실제 서버·라우터·JWT 없음 |
| 격리 DB / DB 제약 / RLS | **BLOCKED** | 격리 DB 없음. 신규 생성·접속은 사전 승인 필요 |
| 실제 JWT+HTTP, 교차 tenant 실계정 | **BLOCKED** | 인증·서버 없음 |
| 두 독립 세션 동시성 | **BLOCKED** | 순차 경쟁(같은 프로세스)으로만 검증 |
| 기존 19개 회귀 테스트 | **BLOCKED** | ordering-dev DB 측 테스트로 이 저장소에 없음 |
| Security Advisor · EXECUTE/GRANT · RLS 확대 점검 | **BLOCKED** | 미실행(접속하지 않음) |
| 릴리스(`ordering-dev` 적용·운영 배포) | **NO-GO** | `release/go_no_go.md` 참조 |

전체 상태: **PARTIAL(도메인 로직 한정) / 릴리스 BLOCKED**. 이 저장소의 통과는 "도메인 규칙이 메모리 저장소에서 의도대로 동작한다"만을 뜻하며 DB·보안·운영 적합성을 뜻하지 않는다.

## 1. 실제 실행한 검증과 출력

| 명령 | 결과 |
|---|---|
| `npx vitest run` | files 113, tests 1132, passed 1132, failed 0 (수령 영속화 추가 후 재실행. 디렉터리별 표도 이 실행의 JSON 집계) |
| `npx tsc --noEmit` | 출력 없음(오류 0) |
| 정적 점검: `git ls-files` 파일명(.env·secret·credential·pem·key) | 해당 없음 |
| 정적 점검: `src tests openapi implementation package.json`에서 JWT·키 패턴, `ordering-dev`·`testBookshare` 프로젝트 ID, `service_role` grep | 해당 없음 |
| 정적 점검: `src`에서 `process.env`·`fetch(`·`http(s)://` grep | 해당 없음 |

디렉터리별 테스트(JSON 보고서 집계):

| 디렉터리 | 파일 | 테스트 |
|---|---|---|
| auth | 11 | 53 |
| catalog | 5 | 18 |
| errors | 1 | 8 |
| http | 3 | 41 |
| idempotency | 2 | 53 |
| openapi | 2 | 26 |
| order | 10 | 111 |
| procurement | 16 | 362 |
| inventory | 26 | 244 |
| payment | 11 | 59 |
| fulfillment | 2 | 16 |
| notification | 6 | 27 |
| closure | 4 | 15 |
| cancellation | 5 | 25 |
| reopening | 1 | 6 |
| db | 8 | 68 |
| **합계** | **113** | **1132** |

(`tests/helpers`는 테스트 파일이 없는 공용 픽스처다.)

## 2. P0 요구사항 추적

추적 단위는 STBR 상태 전이(ST-*)다. 요구사항 ID(FRD)와의 1:1 추적표는 FRD 전체를 읽지 않아 만들지 못했다(한계). 전이별 판정과 근거 테스트는 `testing/test_matrix.csv` 참조.

| 구분 | 구현(PASS) | 부분(PARTIAL) | 미구현 |
|---|---|---|---|
| 주문 ST-O | O01, O03 | O05, O06, O07, O08, O10 | O02, O04, O09 |
| 조달 ST-P | P01, P03~P08, P10 | P02, P09, P11 | — |
| 입고·배분·재고 ST-R/I | R01~R07, I01~I06 | — | — |
| 취소 처분 ST-C | C01~C09 | — | — |
| 안내 ST-M | M01~M06 | — | M07(P1) |
| 수령 ST-F | F01 | F02 | F03(P1) |
| 결제·환급 ST-Y | Y01~Y04, Y06 | Y05, Y07 | Y08·Y09(P2) |
| 인증·계정 ST-A | — | A01~A05·A08 일부 | A06, A07 |
| 도서·공급처·템플릿 ST-B | — | B01~B05 도메인 로직 | YES24 검색 연동 |

**PARTIAL의 의미:** 도메인 규칙은 구현·테스트했으나 아래 한계 중 하나가 남은 것이다. 항목별 한계는 `testing/test_matrix.csv`의 notes에 있다.
- ST-O05/O06: 공급처 의무는 `supplierObligations`로 부분 처리(§9). 미응답·거절 판정은 없음.
- ST-O07/O08: 공급처 외부 의무 차단(`EXTERNAL_OBLIGATION_OPEN`)은 선택 의존성을 연결해야 동작.
- ST-O10: 근거는 결제 보정·수령 정정 두 가지.
- ST-P02/P09/P11: 배정 자동 해제 없음, 부분 해제 없음, 재납품 약속의 새 의무 기록 없음.
- ST-F02: Owner 단일 명령. 정정 직후 안내·결제 영향 점검 없음.
- ST-Y05: 과수납 사유만. ST-Y07: 수동 증빙 모델의 시도 결과 기록·UNKNOWN 예약·조회 해소만.

**P0 범위의 미구현 중 릴리스에 영향이 큰 것:** 서점 중지·해지(ST-A06/A07, P1 정책 승인 전). 도서·공급처·템플릿(ST-B)은 도메인 로직까지 구현했고 외부 YES24 연동만 없다. 이 외 P0 상태 전이의 도메인 로직은 모두 PASS 또는 PARTIAL이 되었다(주문 보류·가격 변경·초안 폐기는 정책 미승인 또는 범위 밖).

## 3. 게이트 G0~G7 (구현현황표 기준)

| 게이트 | 판정 | 증거·한계 |
|---|---|---|
| G0 문서/계약 | PARTIAL | 단계별 보고서에 충돌·미결정 기록. API V2.2·RLS V2.2와의 대조는 하지 않음 |
| G1 격리 DB | BLOCKED | DB 구성 없음 |
| G2 보안 경계 | BLOCKED | JWT·비활성 계정·교차 tenant 실계정 테스트 불가 |
| G3 주문/발주 | PARTIAL | 도메인 PASS, DB·HTTP 없음 |
| G4 재고/인도 | PARTIAL | 도메인 PASS, 원장 대사(DB) 없음 |
| G5 결제/환급 | PARTIAL | 도메인 PASS, 수동 증빙 모델만 |
| G6 종결 | PARTIAL | 도메인 PASS, 원자적 종결은 "검증 후 연속 저장" |
| G7 회귀/승인 | BLOCKED | 19개 테스트·2세션 경쟁·배포 승인 없음 |

구현현황표 D절의 API별 증거 단계(`schema-ready` → `rpc-written` → `isolated-tested` → `jwt-tested` → `integration-tested`) 기준으로 이 저장소의 기능은 **어느 것도 `schema-ready` 이상이 아니다**(스키마·RPC·격리 테스트 없음). Bolt.new가 실제 API에 연결해도 되는 기능은 **없다**.

## 4. 보안 점검

| 항목 | 판정 | 근거 |
|---|---|---|
| Security Advisor | BLOCKED | 미실행 |
| 함수 EXECUTE/GRANT | BLOCKED | 미실행. 구현현황표 B절의 `has_function_privilege` 값은 2026-11-22 문서 기록이며 이번에 재확인하지 않음 |
| RLS 정책 확대 여부 | BLOCKED | 미실행 |
| 저장소 시크릿 | PASS(정적, 한계 있음) | 위 정적 점검 3종. 완전한 시크릿 스캐너가 아님 |
| 외부 호출 | PASS(정적) | 도메인 코드가 PG·알림·네트워크를 호출하지 않음 |
| 금지된 DB 접근 | PASS | `testBookshare`와 `ordering-dev`에 접속하지 않음 |
| 권한 모델 | **부분 완화** | `src/auth`의 `resolvePrincipal`·`bindActor`·`authorizedActions`가 역할·행위자·테넌트·SYSTEM 실행자를 주체에서 주입한다(요청 값은 무시, 구조 테스트로 누락 방지). 단 외부 진입점이 도메인 함수를 직접 호출하면 우회되고, 조회 함수 중 `getOrder`·`listOrders` 외에는 주체에서 주입하지 않았으며, JWT 서명 검증·서버가 없다. 원래 위험(`actorRole`·`executedBy`가 요청 값이라 위조 가능)은 도메인 함수 자체에는 그대로 남아 있다. `SYSTEM` 전용 명령도 동일 |

## 5. 동시성에 대한 정직한 기록

동시성 관련 테스트는 모두 **같은 프로세스에서 순차 호출**한 것이다. 이 테스트들은 "한도 검증이 누적 합산을 사용한다"는 것을 보이지만 **두 요청이 겹치는 경합 조건을 재현하지 못한다.** 해당 항목: 마지막 1권 예약·인도, 환급 요청 중복 방지, 취소 요청 잠금과 인도, 중복 안내·중복 결제 거래, 종결 실행의 version 검사, UNKNOWN 환급 예약 한도, 수령 정정의 누적 한도, 발주 취소·발주 종결의 version 검사. 진짜 동시성은 DB의 잠금·조건부 갱신·유일 제약과 두 독립 연결이 필요하다.

## 6. 원자성에 대한 정직한 기록

복합 명령(취소 적용, 환급 승인, 인도, 재배분, 종결 실행, 재개, 수령 정정, 배정 해제, 발주 종결)은 "모든 검증을 통과한 뒤 연속 저장" 방식이다. 검증 실패 시 아무것도 남지 않음은 테스트로 확인했으나, **저장 도중 실패를 주입해 이미 쓴 기록을 되돌리는 롤백은 구현·검증하지 못했다.** 감사 기록(audit)도 별도 필드·저장소로 구현하지 않았다.

## 7. 릴리스 차단 조건(분리 보고)

`release/go_no_go.md`에 미승인 정책, 법률·YES24 권한, 결제 계약, 개인정보 보존으로 분리해 나열했다.

## 8. 한계

- FRD·ERD·SFS·API V2.2·RLS V2.2 전체를 단계별로 읽지는 못했다(각 단계 보고서의 "읽지 않은 문서" 참조). 요구사항 ID 단위 추적표는 만들지 못했다.
- 이 문서 갱신 자체는 코드를 바꾸지 않았다. 코드 변경은 아래 §9의 9개 커밋에서 있었다.
- 수치는 기준 커밋 `21e22e3`의 작업 트리에서 다시 측정했다. 이 문서·`release/`·`test_matrix.csv` 갱신 커밋 이후의 커밋은 포함하지 않는다.

## 9. 10단계 이후 변경 이력 (4ece379 → 21e22e3)

| 커밋 | 내용 | 전이·규칙 |
|---|---|---|
| 723947b | 전량 취소(CANCELLING) 표시와 신규 거래 차단 | ST-O06, BR-O07 |
| d9a4726 | 취소 종결 `outcome: CANCELLED` 기록 | ST-O08 |
| 24a64c1 | 환급 시도 FAILED/UNKNOWN 보고·예약·해소 | ST-Y07, BR-Y07/Y08/Y12 |
| ca436af | 수령 오기록 정정 역거래(음수 보정 행)와 종결 후 재개 | ST-F02, D21 |
| 6cf15a3 | 미이행 조달 배정 해제와 유지 의무 기록 | ST-P02 |
| 7d8a322 | 미전달 발주 취소 | ST-P09 |
| f8d475b | 발주 종결 서버 실행과 차단 사유 4종 | ST-P11, BR-P02/P06 |
| 6d9bb13 | 해제 후 남는 공급처 의무 파생, 주문 종결 차단, 재조달 중복 위험 승인 | BR-P05 |
| 21e22e3 | 파손·오배송 처리 기록과 발주 종결 차단 | BR-P06, ST-R01 |

테스트는 968 → 1005개(+37), 파일은 76 → 88개(+12)다. 그 뒤 인증·권한 계층(§10)으로 1052개, 100 files가 되었다(직원 관리 §10.1, 카탈로그 §11, 진입점 §12, 주문 도서 검증 §13, 계정·서점 개설 §14).

### 9.1 이번 갱신에서 새로 생긴 위험·주의

- **선택 의존성:** 아래 의존성은 `?`(선택)이라 서버 조립에서 연결하지 않으면 해당 검사가 **조용히 꺼진다**. 필수화는 서버 조립 단계의 과제다.
  - `requestRefund`의 `refundAttempts`·`refundAttemptResolutions`(UNKNOWN 예약)
  - `executeOrderReopening`의 `fulfillmentCorrections`(수령 정정 재개 근거)
  - `evaluateOrderClosure`·`allocateSourcing`의 `supplierObligations`(공급처 의무·중복 위험 승인)
  - 반대로 `receiptDefectResolutions`(발주 종결)는 컴파일 단계에서 누락을 알 수 있도록 필수로 했다.
- **음수 보정 행:** 수령 정정은 수령·인도 원장에 수량이 음수인 행을 추가해 기존 순합계 계산을 그대로 쓴다. 수량이 1 이상이라고 가정하는 코드가 있으면 영향을 받을 수 있다. 현재 테스트는 모두 통과한다.
- **공급처 의무의 과차단 가능성:** 의무 수량을 `min(해제 유지 수량, 발주 품목 잔량)`으로 계산하므로, 같은 발주 품목에 다른 고객의 물량이 남아 있어도 해제한 주문의 의무가 열린 것으로 본다.
- **프로세스 기록:** 일부 단계에서 테스트를 한 번에 둘 이상 작성했거나(ST-Y07 일부, 파손·오배송, 중복 위험 승인), 구현 뒤에 특성화 테스트를 추가했다(ST-P02 SENT, ST-P09 일부, ST-O08 환급 차단). 각 커밋 보고에 기록했으며, 해당 테스트는 RED 없이 통과했다.
- **권한:** 새 명령(`correctFulfillment`, `resolveReceiptDefect`, `approveDuplicateRisk` 등)의 `actorRole`도 요청 값이다. §4의 권한 모델 위험이 그대로 적용된다.

## 10. 인증·권한 계층 (ac366ed 이후, T7 부분 해소)

`src/auth`에 다음을 추가했다. 테스트 16개(`tests/auth/resolvePrincipal`·`bindActor`·`authorizedActions`).

| 구성 | 역할 |
|---|---|
| `resolvePrincipal` | 검증이 끝난 신원(userId·tenantId·sessionExpiresAt)에서 USER 주체를 만든다. 역할은 멤버십에서 온다. 세션 만료·형식 오류는 UNAUTHENTICATED, 비활성·타 테넌트·비멤버는 같은 FORBIDDEN. 멤버십은 매 호출 다시 읽어 직원 비활성화가 즉시 반영된다(ST-A05, ST-A08) |
| `createSystemPrincipal` | 서버 내부 업무용 SYSTEM 주체 |
| `bindActor` | 명령의 `tenantId`·역할·행위자 이름·`executedBy`를 요청 본문이 아니라 주체에서 주입하고(위조 값은 덮어씀), 허용되지 않은 주체는 명령을 호출하기 전에 FORBIDDEN으로 거부 |
| `authorizedActions` | 역할·SYSTEM 실행자·행위자 이름(`...By`)·테넌트를 요청으로 받는 70개 함수를 바인딩한 모음(역할/SYSTEM 19개 + 행위자 이름 31개 + 테넌트만 주입 9개 + 직원 관리 3개 + 카탈로그 6개 + 조회 2개). 구조 테스트 3개가 `actorRole`·`executedBy`를 받거나, 멱등 키와 `...By` 필드를 가졌거나, 멱등 키와 `tenantId`를 가진 명령 파일이 이 모음에서 빠지면 실패시킨다 |

**남은 한계**
- 외부 진입점이 `authorizedActions` 대신 도메인 함수를 직접 호출하면 우회된다. 진입점 규약과 서버 조립에서 강제해야 한다.
- 조회는 `getOrder`·`listOrders`만 모음에 있다. 다른 조회성 함수가 생기면 같은 방식으로 추가해야 하며, 조회 누락을 잡는 구조 테스트는 없다(§12).
- JWT 서명 검증·키 관리·서버가 없다. `resolvePrincipal`은 검증이 끝난 신원을 입력으로 받는다고 가정한다.
- ST-A06/A07(중지·해지)은 구현하지 않았다(P1 정책 승인 전). 이메일 인증·서점 개설은 §14, 직원 관리는 §10.1.

### 10.1 직원 초대·비활성화·복구 (ST-A03~A05)

테스트 11개(`tests/auth/inviteStaff`·`acceptInvitation`·`revokeInvitation`·`setMembershipStatus`).

| 명령 | 규칙 |
|---|---|
| `inviteStaff` (Owner) | 이메일 정규화·형식 검증, 만료는 지금 이후 30일 이내, 같은 이메일의 유효 초대가 있으면 BUSINESS_INVARIANT. 토큰은 한 번만 반환하고 SHA-256 해시만 저장. 초대는 STAFF만(Owner 추가 정책 미정) |
| `acceptInvitation` | 토큰 해시·확인된 이메일·만료·철회·재사용을 검증. 틀린 토큰·다른 이메일·만료·철회·재사용은 이유를 구별할 수 없는 같은 FORBIDDEN. 이미 멤버십이 있으면 BUSINESS_INVARIANT. 성공하면 활성 Staff 멤버십 생성 |
| `revokeInvitation` (Owner) | INVITED만 철회. 수락·철회·만료된 초대는 BUSINESS_INVARIANT |
| `setMembershipStatus` (Owner) | ACTIVE↔INACTIVE, 변경 기록(추가 전용). 비활성화는 `resolvePrincipal` 재조회로 즉시 반영. 마지막 활성 Owner는 비활성화 불가(BR-T06) |

초대 상태(INVITED/ACCEPTED/REVOKED/EXPIRED)는 사건 기록과 만료 시각에서 파생한다. 만료는 별도 기록 없이 시각으로 판정한다.

**한계**
- `acceptInvitation`은 `verifiedEmail`·`userId`를 요청으로 받으므로 호출자가 보증해야 한다. 이메일 인증 계정에서 이 값을 가져오는 `acceptInvitationAsAccount`(§14)를 쓰는 것이 안전한 경로다.
- 이미 멤버인 사용자의 이메일로 초대하는 것은 막지 못한다(멤버십이 이메일을 갖지 않는다).
- 멱등 재생은 같은 응답(토큰 포함)을 돌려준다. 멱등 저장소에 평문 토큰이 남는 점에 유의해야 한다.
- Owner 추가·강등·역할 변경·탈퇴는 없다. 초대 수락에는 `authorizedActions`를 쓰지 않는다(테넌트가 토큰에서 정해지고 주체가 아직 없음).
- 중복 초대 검사는 `invitations.list`를 전수 조회한다(메모리 저장소 가정).

## 11. 도서·공급처·문구 템플릿 (ST-B01~B05, `src/catalog`)

테스트 18개(`tests/catalog`). 모든 명령은 `authorizedActions`에 바인딩했다(68개 중 6개).

| 명령 | 전이 | 규칙 |
|---|---|---|
| `registerBook` | ST-B01/B02 | YES24 선택은 출처·외부 ID·조회 시각 필수, 수기는 사유 필수, 판매가는 양의 정수 문자열, ISBN은 숫자만 정규화(10/13자리 형식만 검증). 같은 ISBN의 도서는 중복 후보로 거부하고 확인 표시(`acknowledgeDuplicateOf`)가 있어도 병합하지 않음 |
| `updateBook` | ST-B03 | version 검사, 수정 전·후 값을 이력에 보존, 출처 정보 불변, ISBN 변경 시 중복 후보 확인. 기존 주문 단가는 주문 품목이 따로 갖고 있어 불변 |
| `registerSupplier`·`updateSupplier`·`setSupplierActive` | ST-B04, SUP-001/002 | Owner 또는 점주가 위임한 직원. 발주 방식(WEB·EMAIL·PHONE·MESSENGER·FILE·API) 기록, 코드 중복 차단, 변경 이력. 비활성화는 신규 배정을 막고 진행 중 발주를 바꾸지 않으며 그 발주를 이력에 기록 |
| `publishTemplateVersion`·`renderTemplate` | ST-B05 | 버전 vN→vN+1 추가 전용, 최신 버전 불일치는 VERSION_CONFLICT, 허용 변수 6종만(연락처·이름 제외), 이전 버전은 그대로 렌더링 가능 |

**해석·승인 필요**
- 허용 문구 변수 목록(`ALLOWED_TEMPLATE_VARIABLES`)과 개인정보 제외는 DEC-12 법률 검토 전의 보수적 해석이다.
- 공급처 관리는 Owner 또는 "위임 직원"이다. 위임 저장소(`managementDelegations`)는 재고 조정 위임과 별개로 주입하며, 위임을 부여하는 명령은 아직 없다.
- 도서 `listPriceKrw`는 판매가이고 DEC-08(확정 가격 변경)과 무관하다. 주문 품목은 제목·ISBN 스냅샷을 저장하지 않고 `bookId`와 단가만 가진다(BOOK-007 부분).

**한계**
- YES24 검색·조회 연동은 없다(DEC-17 외부 권한 검증 필요). 외부 결과는 호출자가 넘기는 값이며 시스템이 검증하지 않는다.
- ISBN 체크 숫자는 검증하지 않는다. 제목·저자 기반 중복 후보는 찾지 않는다.
- 도서 비활성화·삭제, 서점별 취급·가격·메모 분리(BOOK-008, P1), 도서 검색(BOOK-005)은 구현하지 않았다.
- 공급처 코드는 영문 소문자·숫자·하이픈이며 기존 공급처 모델에 `name`·`orderChannel`·`version`을 선택 필드로 추가했다(기존 데이터는 `version` 없음을 1로 본다).
- 주문 생성(`createOrderService`)은 도서 레코드를 조회하지 않는다. 존재하지 않는 `bookId`도 주문에 담긴다.

## 12. 진입점 규약 (§10의 "우회 가능" 한계 부분 해소)

**규약:** 외부 진입점(`*Api.ts`, `src/http/`)은 도메인 함수를 직접 호출하지 않고 `authorizedActions`로만 호출한다. 호출 전에 `resolvePrincipal`(세션 만료·활성 멤버십) 또는 `authorizeTenantAccess`로 주체를 만든다.

- `createOrderApi`를 이 규약으로 옮겼다. 공개 계약(`Actor = { userId }`, 응답·오류 형태)은 그대로이며 기존 http·OpenAPI·orderApi 테스트가 수정 없이 통과한다. 요청의 `tenantId`는 호출자가 그 테넌트의 활성 멤버일 때만 주체의 테넌트가 되고, 도메인 함수에는 주체의 값만 전달된다.
- `getOrder`·`listOrders`를 모음에 추가했다. 요청이 다른 테넌트를 주장해도 주체의 테넌트만 조회된다.
- 구조 테스트가 `*Api.ts`·`src/http/` 파일이 모음의 어떤 함수도 `authorizedActions.` 없이 직접 호출하면 실패시킨다.

**남은 한계**
- 구조 테스트는 현재 있는 진입점 파일 이름 규칙(`*Api.ts`, `src/http/`)만 감시한다. 다른 이름의 진입점이 생기면 규칙을 따르도록 리뷰해야 한다.
- `createOrderApi`는 세션 만료를 검사하지 않는다(`Actor`에 만료 시각이 없다). 토큰 검증 계층이 `resolvePrincipal`로 먼저 거르는 구조가 필요하다.
- 조회성 함수(예: 향후 목록·상세)의 모음 등록 누락을 잡는 구조 테스트는 없다. 명령은 멱등 키로 식별해 감시하지만 조회는 식별 기준이 없다.
- HTTP 라우터·JWT 서명 검증·서버는 여전히 없다.

## 13. 주문 생성의 도서 검증과 스냅샷 (BOOK-007)

테스트 3개(`tests/order/createOrderCatalog`·`orderApiCatalog`).

- `createOrderService`에 선택 의존성 `books`를 추가했다. 연결하면 모든 품목의 `bookId`가 이 테넌트의 카탈로그에 있어야 하고(없거나 다른 테넌트의 도서는 존재 여부를 구별할 수 없는 같은 400 VALIDATION_ERROR), 주문 품목에 `bookTitle`·`bookIsbn`(있을 때)·`listPriceKrw` 스냅샷이 저장된다. 이후 도서를 수정해도 기존 주문은 바뀌지 않는다.
- 운영 진입점 `createOrderApi`는 `books`를 **필수**로 받는다. 연결을 빠뜨리면 컴파일 오류다. 응답의 품목에 스냅샷이 포함되며 `openapi/ordering.yaml`의 `OrderLine`에 선택 필드로 반영했다(계약 테스트 통과).
- 기존 `createOrderService` 테스트(4필드 `lines`를 `toEqual`로 확인)는 `books`를 연결하지 않은 경로라 수정 없이 그대로 통과한다. 기존 http·orderApi·계약 테스트의 설정에만 `books`를 연결했고(`tests/helpers/anyBookRepository.ts`: 어떤 `bookId`도 있는 것으로 보는 시험용 저장소) 검증 내용은 바꾸지 않았다.

**한계**
- `books`가 선택이라 `createOrderService`를 직접 쓰면 검증이 꺼진다. 진입점은 `createOrderApi`(필수)이며, `authorizedActions.createOrderService`를 `books` 없이 호출하는 경로는 막지 못한다.
- `unitPriceKrw`는 호출자가 보낸 값 그대로다. 정가와 달라도 허용하며(할인·배송비는 미결정), 정가는 스냅샷으로만 남는다. 가격 변경 규칙(DEC-08)은 다루지 않았다.
- 도서 비활성화가 없어 "비활성 도서 주문 차단"은 없다. 이미 만들어진 주문에는 소급하지 않는다.
- 주문 확정(`confirmOrderService`)은 도서를 다시 확인하지 않는다.

## 14. 이메일 인증과 서점 개설 (ST-A01, ST-A02)

테스트 9개(`tests/auth/accounts`·`openStore`·`acceptInvitationAsAccount`).

| 구성 | 규칙 |
|---|---|
| `registerAccount` | 사용자 ID(인증 제공자 발급)와 이메일로 UNVERIFIED 계정 등록. 이메일은 소문자 정규화, 같은 이메일·같은 사용자 ID 재가입은 BUSINESS_INVARIANT. 인증 토큰은 응답으로 한 번만 돌려주고 SHA-256 해시만 저장, 유효 24시간. 비밀번호·자격 증명은 저장하지 않는다 |
| `verifyEmail` (SYS) | 토큰으로 UNVERIFIED→VERIFIED. 틀린 토큰·만료·재사용은 이유를 구별할 수 없는 같은 FORBIDDEN. 사용된 토큰은 소비 기록으로 재사용 차단 |
| `resolveAccountPrincipal` | 서점에 속하기 전의 계정 주체(`kind: "ACCOUNT"`, 이메일 인증 여부 포함). 세션 만료·미등록 계정은 UNAUTHENTICATED |
| `openStore` (ST-A02) | 이메일을 인증한 계정만(미인증 FORBIDDEN). 이름 1~60자. 활성 Tenant와 Owner 멤버십을 함께 생성하고, 같은 멱등 키의 재시도는 같은 결과를 돌려주며, 같은 소유자의 같은 이름(대소문자 무시)은 다른 키라도 BUSINESS_INVARIANT. 생성 직후 `resolvePrincipal`로 Owner 주체를 도출할 수 있다 |
| `acceptInvitationAsAccount` | 초대 수락에서 사용자 ID·확인된 이메일을 요청이 아니라 계정 주체에서 가져옴. 미인증 계정·이메일이 다른 계정은 FORBIDDEN |

**한계**
- `openStore`는 서점·멤버십을 "검증 후 연속 저장"한다. 두 번째 저장 실패 시 서점만 남는 부분 상태를 되돌리는 롤백은 없다(§6과 같은 한계).
- 한 소유자가 서점을 여러 개 열 수 있다(이름만 달라야 함). 개수 제한 정책은 문서에 없어 정하지 않았다.
- 인증 토큰 재발송·만료 후 재발급, 비밀번호 재설정(AUTH-007), 탈퇴는 없다. 토큰 발송 자체는 호출자의 몫이다.
- 계정 저장소는 사용자 ID와 이메일 유일성을 가정한다. 이메일 변경은 없다.
- `AccountPrincipal`을 받는 명령(`openStore`, `acceptInvitationAsAccount`)은 `authorizedActions`(테넌트 주체용) 대상이 아니다. 진입점이 `resolveAccountPrincipal`로 주체를 만들어 전달해야 한다.
- 서점 중지·해지(ST-A06/A07)는 P1 정책 승인 전이라 구현하지 않았다. 개인정보 접근·내보내기(UC-25)도 마찬가지다.

## 15. 격리 DB 스키마·RLS 첫 증분 (E1 승인 후)

테스트 22개(`tests/db`). 격리 로컬 Postgres 17.12에서만 실행했다. `ordering-dev`·`testBookshare`에는 접속하지 않았고 접속 정보가 코드에 없다.

| 구성 | 내용 |
|---|---|
| `src/db/migrate.ts` | `db/migrations/*.sql`을 파일명 순서로 1회 적용, 파일마다 트랜잭션(실패 시 롤백·미기록), 적용 후 내용 변경 거부, 체크섬은 줄바꿈(CRLF/LF) 정규화 |
| `db/test-support/supabase_shim.sql` | 테스트 전용. `anon`·`authenticated`·`service_role` 역할과 `auth.uid()`(요청 JWT 클레임 `sub`)를 흉내 낸다. 실제 Supabase에는 적용하지 않는다 |
| `001_foundation.sql` | `ordering_tenants`·`ordering_members`, `private.is_ordering_member`(SECURITY DEFINER, `search_path` 빈 값 고정, anon 실행 불가), 클라이언트에 SELECT만 허용하는 RLS(Owner는 구성원 전체·Staff는 본인 활성 행), **마지막 활성 Owner 보호 트리거**(행 잠금으로 두 세션의 동시 비활성화 중 하나만 통과) |
| `002_orders.sql` | `ordering_orders`·`ordering_order_lines`: 복합 FK `(tenant_id, order_id)`, 확정 주문만 표시번호·합계(CHECK), 서점별 표시번호 유일, 갱신 시 `version`이 정확히 +1(낙관적 잠금 DB 강제), CONFIRMED→DRAFT 금지, 품목은 초안에만 추가·수량 감소만 허용, 읽기 RLS, 쓰기는 `service_role`만 |

**검증된 것:** anon 42501, 비멤버·타 서점 0행(UUID를 알아도), 비활성 직원 즉시 차단, JWT에 OWNER 역할 클레임을 넣어도 멤버십만 신뢰(RLS-07), 직접 DML 차단, 교차 서점 FK 거부(23503), 두 독립 세션의 실제 경쟁 3건(유일 제약, 마지막 Owner 동시 비활성화, 같은 version 동시 확정에서 한쪽은 0행).

**한계**
- **범위:** 테넌트·멤버십·주문·품목뿐이다. 재고·예약·배분·발주·입고·결제·환급·안내·감사 스키마와 원장 append-only 트리거는 없다.
- **shim:** 실제 Supabase의 `auth` 스키마(`auth.users`)·JWT 검증·PostgREST·역할 상속 설정과 다를 수 있다. 실제 Supabase 프로젝트에서 같은 마이그레이션을 재검증하지 않았다. `owner_user_id`·`user_id`는 `auth.users` FK 없이 uuid다.
- **도메인 코드와 DB가 아직 연결되지 않았다.** 도메인 함수는 모두 동기식이고 저장소 인터페이스도 동기식인데 Postgres 드라이버는 비동기다. 이 간극을 메우는 영속화 방식은 사용자 결정이 필요하다(`release/approval_items.md` E7). 그래서 "기존 도메인 테스트가 DB에서도 통과"하는 검증과 도메인 수준 동시성(마지막 1권 등)은 아직 없다.
- **쓰기 경로:** 백엔드가 `service_role`로 쓰면 RLS를 우회하므로 권한은 `authorizedActions`가 책임진다. 백엔드가 요청마다 `authenticated` 역할과 JWT 클레임으로 전환해 RLS를 방어선으로 쓰는 구성도 가능하며, 이 선택(E7과 함께 결정)은 아직 하지 않았다.
- 조회 전용 `security_invoker` 뷰·민감 테이블 최소 필드 조회·RPC EXECUTE 점검은 해당 테이블이 없어 하지 않았다.

## 16. 주문 영속화 어댑터 (E7 권고안 a 구현, `src/db/pgOrderApi.ts`)

테스트 9개(`tests/db/pgOrderApi.test.ts`), 격리 로컬 Postgres 17.12.

**방식:** 요청마다 한 트랜잭션에서 ① 멤버십 ② 주문·품목(쓰기는 `FOR UPDATE`) ③ 같은 키의 멱등 기록 ④ 주문이 가리키는 도서를 적재하고, **기존 동기 `createOrderApi`를 코드 변경 없이 그대로 실행**한 뒤, 변경분(주문·품목·멱등 기록·표시번호 카운터)을 같은 트랜잭션에 저장한다. 도메인이 던진 오류는 트랜잭션을 롤백한다. 쓰기는 `service_role`, 읽기는 `authenticated`+JWT 클레임(`sub`)으로 실행해 RLS가 서점·활성 멤버십을 한 번 더 거른다.

`003_books_commands_counters.sql`이 `ordering_books`(RLS 읽기, 서버 쓰기), `ordering_commands`(멱등 기록, 클라이언트 권한 없음), `ordering_counters`(서점별 표시번호)를 추가했다.

| 검증한 것 | 결과 |
|---|---|
| 주문·품목·스냅샷·멱등 기록이 함께 저장되고 새 API 인스턴스(재시작)에서도 조회 | 통과 |
| 같은 멱등 키·같은 본문은 같은 주문, 다른 본문은 `IDEMPOTENCY_CONFLICT`(재시작 뒤에도) | 통과 |
| 없는 도서·타 서점 도서·수량 0은 400이고 주문·멱등 기록이 남지 않음(롤백) | 통과 |
| 확정 시 서점별 표시번호 1부터 순차, 서점 사이 독립, 낡은 version·재확정 거부 | 통과 |
| 비멤버·비활성 FORBIDDEN, 인증 없음 UNAUTHENTICATED, 타 서점 주문 ID는 없는 ID와 같은 NOT_FOUND | 통과 |
| 목록 최신순·상태 필터·커서, 타 서점 주문 비노출 | 통과 |
| **두 독립 연결 동시성** 3건: 같은 주문 동시 확정은 하나만 성공(진 쪽은 커밋된 CONFIRMED를 읽고 `BUSINESS_INVARIANT`), 서로 다른 주문 5건 동시 확정의 표시번호가 중복 없이 연속, 같은 멱등 키 동시 생성은 주문 1건·같은 결과 | 통과 |

**한계**
- **범위:** 주문 API 4개(생성·확정·상세·목록)만 영속화했다. 재고·예약·배분·발주·입고·결제·환급·안내·종결 등 나머지 도메인은 스키마도 어댑터도 없다. 이 방식을 각 영역에 반복해야 한다(영역마다 "무엇을 잠그고 적재하는가"를 정의).
- **적재 범위:** 목록은 서점의 주문 전체를 적재해 도메인 `listOrders`로 걸러낸다. 주문이 많아지면 SQL 쪽 페이지네이션이 필요하다.
- **저장 도중 실패 주입 롤백**은 시험하지 않았다. 도메인 오류에 의한 롤백과 한 트랜잭션 구조까지만 확인했다(T4는 여전히 부분).
- 멱등 기록에 도메인 결과를 JSON으로 저장한다. 결과 형태가 바뀌면 오래된 기록 호환 정책이 필요하다.
- `createPgOrderApi`는 풀을 받기만 하며 접속 정보·환경 변수·HTTP 서버는 없다. 서버(E2: Node.js)에서 이 어댑터를 라우터에 연결하는 일이 남았다.
- 읽기 경로의 `userId`가 UUID가 아니면 DB에 보내지 않고 FORBIDDEN/UNAUTHENTICATED로 처리한다(Supabase 사용자 ID는 UUID).

## 17. 재고 예약 영속화와 "마지막 1권" 실제 동시성 (`src/db/pgStockApi.ts`, `004_stock.sql`)

테스트 11개(`tests/db/pgStockApi.test.ts`), 격리 로컬 Postgres 17.12. 동시성 테스트는 4회 반복 실행에서도 모두 통과했다.

**스키마 `004_stock.sql`:** `ordering_stock_movements`(수불 원장), `ordering_stock_reservations`(예약), `..._releases`·`..._deliveries`(해제·인도, 정정은 음수), `ordering_sourcing_allocations`(조달 계획량). 원장 4종은 **추가 전용**(UPDATE·DELETE는 서버 역할도 P0001). 복합 FK `(tenant_id, order_id, order_line_id)`로 다른 서점의 품목에 예약을 붙일 수 없다. 읽기 RLS는 같은 서점의 활성 멤버, 쓰기는 `service_role`만.

**동시성 제어:** 예약은 책 단위 경합이라 `(서점, 책)`으로 `pg_advisory_xact_lock`을 잡는다. 어댑터가 잡고, **같은 락을 INSERT 트리거도 잡아** 어댑터를 거치지 않는 직접 SQL도 "예약 합계 ≤ 보유 재고"를 지킨다. 락을 잡은 뒤에 원장·멱등 기록을 읽어야 먼저 커밋된 예약과 같은 키의 결과가 보인다(처음 구현은 멱등 기록을 락 전에 읽어 이 경쟁에서 실패했고 테스트가 잡았다).

| 검증한 것 | 결과 |
|---|---|
| 예약 저장·가용 재고 감소, 같은 멱등 키는 같은 예약(재시작 뒤에도), 다른 본문은 `IDEMPOTENCY_CONFLICT` | 통과 |
| 행위자는 요청이 아니라 인증된 사용자로 기록(요청의 `reservedBy` 위조 무시) | 통과 |
| 가용 재고 초과·품목 미배정량 초과·활성 조달 배정 차감·초안 주문 거부 | 통과 |
| 비멤버·비활성 FORBIDDEN, 인증 없음 UNAUTHENTICATED, 타 서점 주문·없는 품목 NOT_FOUND | 통과 |
| **마지막 1권을 두 주문이 동시에 예약 → 하나만 성공** | 통과 |
| **재고 3권에 주문 8건이 동시에 1권씩 → 정확히 3건 성공, 예약 합계 3** | 통과 |
| 같은 품목 2권을 2권씩 두 번 동시에 → 하나만 성공 | 통과 |
| 같은 멱등 키 동시 예약 → 예약 1건·같은 결과 | 통과 |
| 직접 SQL의 재고 초과 예약 거부, **두 세션이 마지막 1권을 직접 넣어도 하나만 통과** | 통과 |
| 원장 수정·삭제 거부, 책 키 불일치(P0001)·타 서점 연결(FK 23503) 거부, RLS 읽기·직접 쓰기 차단 | 통과 |

이 결과로 §5(동시성에 대한 정직한 기록)의 "마지막 1권 예약"은 **순차 경쟁이 아니라 실제 두 독립 연결 경쟁으로 검증**되었다. 마지막 1권의 **인도·배분**, 환급 요청 중복, 취소 요청 잠금과 인도는 여전히 순차 경쟁이다.

**한계**
- 예약 명령 하나만 영속화했다. 해제·인도·재고 조정·초기 재고 등록·입고 배분·반품·취소 처분은 스키마(해제·인도 테이블 일부)만 있거나 없다. 같은 방식(책 락 + 적재 → 도메인 → 저장)을 반복해야 하고, 인도는 주문·수령·결제 원장과 한 트랜잭션이어야 해서 영역 간 락 순서(주문 → 책)를 정해야 한다.
- 품목별 미배정량 한도는 도메인과 어댑터가 지킨다. DB 트리거는 책 단위 재고 한도만 강제한다(품목 한도의 DB 강제는 없음).
- 조달 배정은 읽기 전용 테이블뿐이다. 배정 생성·해제 명령은 영속화하지 않았다.
- 재고 이동(초기 재고)은 시험에서 SQL로 시드했다. `registerInitialStock`·`adjustStock`의 영속화는 없다.
- 책 락은 어드바이저리 락이라 연결이 풀 단위로 끊겨도 트랜잭션 종료와 함께 풀린다. 락 대기 시간 상한(`lock_timeout`)은 설정하지 않았다.

## 18. 결제·환급 영속화와 환급 한도의 실제 동시성 (`src/db/pgPaymentApi.ts`, `005_payments_refunds.sql`)

테스트 13개(`tests/db/pgPaymentApi.test.ts`), 격리 로컬 Postgres 17.12. 동시성 포함 33개(주문·재고·결제 어댑터)를 4회 반복 실행해도 모두 통과했다.

**방식:** 주문 하나의 결제·환급 원장 전체(결제·확인·무효·보정·환급 업무·요청·결정·환급 원장·시도)를 한 단위로 적재한다. 명령마다 한 트랜잭션에서 권한 → 주문 공유 잠금 → `(서점, 주문)` 어드바이저리 락 → 원장 적재 → 멱등 기록 적재(락 뒤) → **기존 도메인 실행** → 새 기록 저장이다. 어댑터는 `recordPayment`·`confirmPayment`·`openRefundTask`·`requestRefund`·`decideRefundRequest`(승인 시 환급 원장 기록)를 감싸며 모두 `authorizedActions`를 거친다.

**DB가 끝까지 강제하는 불변식(`005`):** 모든 원장 추가 전용, 같은 외부 거래(`방법+참조`) 서점 안 유일(DEC-14), 요청당 결정 1회, 요청당 환급 원장 1줄, 확인↔무효 배타, 서점 안 활성 환급 업무 1개, 환급 **요청** 한도(업무 남은 필요액·원 결제 가용액에서 확정 환급·진행 중 요청·미해소 UNKNOWN 시도를 뺌), 환급 **원장** 한도(업무 필요액·결제액−보정−기환급). 같은 주문 락을 트리거도 잡아 어댑터를 거치지 않는 SQL 쓰기도 직렬화된다. 결제·증빙은 민감 정보라 클라이언트(authenticated·anon)에는 어떤 권한도 없다(RLS-03).

| 검증한 것 | 결과 |
|---|---|
| 입력 → 확인 → 환급 업무 → 요청 → Owner 승인의 전체 흐름, 행위자는 인증된 사용자로 기록, Staff 승인 FORBIDDEN, 재결정 거부 | 통과 |
| 멱등 재생(재시작 뒤에도)·다른 본문 `IDEMPOTENCY_CONFLICT`, 요청의 행위자 위조 무시 | 통과 |
| 같은 외부 거래 중복(다른 주문 포함), 초안 주문, 비멤버·비활성 FORBIDDEN, 인증 없음, 타 서점 NOT_FOUND | 통과 |
| 환급 한도 초과·활성 업무 중복·미확인 결제 거부, 미해소 UNKNOWN 시도 예약(TC-90) | 통과 |
| **같은 업무에 두 세션이 동시에 3,000원씩 환급 요청 → 하나만 접수(합계 ≤ 5,000)** | 통과 |
| **두 세션이 같은 환급 요청을 동시에 승인 → 환급 원장 1건** | 통과 |
| 승인과 거절의 동시 결정 → 결정 1건, 승인이 이길 때만 원장 | 통과 |
| 같은 외부 거래를 다른 주문에 동시에 기록 → 1건 | 통과 |
| 같은 멱등 키 동시 입력 → 결제 1건·같은 결과 | 통과 |
| 직접 SQL로 한도 초과·요청 중복 원장 거부, **두 세션이 남은 금액을 직접 동시에 넣어도 하나만 통과** | 통과 |
| 원장 수정·삭제 거부, 요청당 결정 1회, 금액·방법 제약, 클라이언트 직접 접근 42501 | 통과 |

이로써 §5의 "환급 요청 중복 방지"는 순차 경쟁이 아니라 **실제 두 독립 연결 경쟁으로 검증**되었다.

**한계**
- 결제 무효·보정(`voidPayment`, `correctPayment`), 환급 시도 보고·해소(`reportRefundAttempt`, `resolveRefundAttempt`)는 테이블·DB 가드·적재까지만 있고 어댑터 명령은 없다(시도는 SQL로 시드해 예약만 검증했다).
- 결제 원장 읽기 API(조회·요약)가 없다. 클라이언트 직접 조회는 막았고, 서버가 도메인 권한을 거쳐 제공하는 읽기 명령이 필요하다.
- 주문 취소·종결과 결제 원장을 한 트랜잭션으로 묶는 경로(취소 적용 → 환급 필요)는 영속화하지 않았다. 지금 락은 주문 → 결제 원장 순서이며, 인도·취소 적용 영속화 때 책 락과의 순서를 정해야 한다.
- 결제 입력은 주문이 열려 있는지(초안·종결·전량 취소)를 도메인이 검사한다. DB 트리거는 이를 강제하지 않는다.
- 환급 요청의 한도 계산이 도메인(메모리)과 DB 트리거(SQL)에 이중으로 있다. 한쪽을 바꾸면 다른 쪽도 바꿔야 하며, 어긋나면 DB가 `BUSINESS_INVARIANT`로 거부한다.
- 하나의 `ordering_commands` 키 공간을 모든 어댑터가 공유한다. 서로 다른 작업 이름이라 충돌하지 않지만 키 재사용 정책(보존 기간)은 정하지 않았다.

## 19. 수령(인도)·취소 요청 영속화와 인도 경쟁 (`src/db/pgFulfillmentApi.ts`, `006_fulfillment_cancellation.sql`)

테스트 13개(`tests/db/pgFulfillmentApi.test.ts`). 주문·재고·결제·수령 어댑터 46개를 5회 반복 실행해도 모두 통과했고, 전체 스위트는 113 files / 1132 tests가 32초에 통과했다.

**락 순서(교착 방지):** 주문 행(`FOR SHARE`) → 주문 인도 락(`ful:<서점>:<주문>`) → 책 락(`<서점>:<책>`, 정렬 순). 예약은 주문 → 책, 결제는 주문 → 결제(`pay:`) 순서라 서로의 부분 순서와 모순되지 않는다. 인도와 취소 요청은 같은 인도 락으로 직렬화되므로 D27 경쟁이 막힌다. 서로 다른 주문이 같은 책을 동시에 인도하는 시험에서 교착이 없음을 확인했다.

**스키마 `006`:** `ordering_fulfillments`(정정은 음수 행, 추가 전용), `ordering_order_cancellation_requests`·`..._decisions`(상태는 마지막 결정에서 파생, 순서는 `seq`). DB 트리거가 직접 SQL도 막는다: 수령은 품목 인도 가능량(품목 수량 − 순 수령 − 진행 중 취소 요청 잠금)과 확인된 결제액을 넘지 않고, 정정은 인도한 것보다 많이 되돌리지 않는다. 취소 요청은 열린 확정 주문의 현재 version 기준이며 미인도·미잠금 수량 이내다. 예약 인도·해제는 예약 잔량 이내, 재고 출고는 보유 재고 이하로 내려가지 않는다.

| 검증한 것 | 결과 |
|---|---|
| 인도 시 수령 기록·예약 인도·재고 출고가 한 트랜잭션으로 저장, 멱등 재생(재시작 뒤에도), 수령자는 인증된 사용자 | 통과 |
| 결제 미확인·확인액 부족·품목 수량 초과·다른 품목의 예약 출처 거부, 없는 예약 NOT_FOUND | 통과 |
| 입고 배분 출처 VALIDATION_ERROR(미영속), 비멤버·비활성 FORBIDDEN, 인증 없음, 타 서점 NOT_FOUND | 통과 |
| 취소 요청 저장, 인도·잠금을 넘는 요청·낡은 version 거부, **진행 중 요청이 있는 수량은 인도 불가(D27)** | 통과 |
| **마지막 1권(예약 1권)을 두 세션이 동시에 인도 → 하나만 성공** | 통과 |
| **예약 2권에 세 세션이 동시에 1권씩 인도 → 정확히 2건, 보유 재고 0 미만 없음** | 통과 |
| **취소 요청과 인도가 같은 2권을 두고 동시에 → 하나만 성공(인도 + 잠금 = 2)** | 통과 |
| 같은 멱등 키로 동시에 인도 → 수령 1건·예약 인도 1건 | 통과 |
| 서로 다른 두 주문이 같은 책을 동시에 인도 → 교착 없이 둘 다 성공 | 통과 |
| 직접 SQL: 품목 수량·결제액 초과 수령 거부, 두 세션이 마지막 1권을 직접 넣어도 하나만 통과 | 통과 |
| 직접 SQL: 취소 요청 한도·잠금, 거절 시 잠금 해제, 예약 인도 초과·되돌림 초과·재고 음수 거부, 추가 전용 | 통과 |

이로써 §5의 "마지막 1권 예약·인도", "취소 요청 잠금과 인도"는 **순차 경쟁이 아니라 실제 두 독립 연결 경쟁으로 검증**되었다.

**한계**
- 수령은 **재고 예약 출처만** 영속화했다. 입고 배분 출처는 입고·배분 스키마가 없어 어댑터가 `VALIDATION_ERROR`로 거부한다. 입고·배분·반품·취소 처분을 영속화하기 전에는 입고 물량 수령에 쓸 수 없다.
- 취소 요청의 승인·거절·철회·적용(`decideOrderCancellation`, `applyOrderCancellation`)은 영속화하지 않았다. 결정 테이블과 D27 잠금 계산(DB·어댑터)은 있지만 결정 기록은 시험에서 SQL로 넣었다. 취소 적용은 주문 수량·예약 해제·환급 필요까지 한 트랜잭션으로 묶어야 해 락 순서(주문 → 인도 → 책 → 결제) 설계가 필요하다.
- 수령 정정(ST-F02)의 영속화 명령과 주문 종결·재개 영속화는 없다.
- 수령 가드의 결제 충당은 도메인과 같이 확인된 결제 합계만 보며 환급·보정을 빼지 않는다(도메인의 현재 규칙을 그대로 따름).
- 한도 계산이 도메인(메모리)과 DB 트리거(SQL)에 이중으로 있다. 어긋나면 DB가 `BUSINESS_INVARIANT`로 거부한다.
- 수령은 주문의 열림 상태(초안·종결·전량 취소)를 도메인이 검사하고, DB는 취소 요청 쪽만 강제한다.

