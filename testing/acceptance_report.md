# 통합 인수 보고서 (10단계)

작성일: 2026-11-24 (갱신) · 기준 커밋: `21e22e3bbba75f9351cdff8c05b608847edac3d1` (`main`, 작업 트리 변경 없음 — 이 문서 갱신 전 상태). 최초 10단계 판정은 `4ece379`에서 했고, 그 뒤 P0 도메인 기능 9개 커밋이 추가되어 이 문서를 다시 측정해 갱신했다(§9).
환경: Windows 11, Node v24.18.0, npm 12.0.0, TypeScript 7.0.2, vitest 5.1.1.
상세 항목별 판정은 `testing/test_matrix.csv`에 있다. 이 문서는 요약·증거·한계를 기록한다.

## 0. 최종 판정

| 영역 | 판정 | 한 줄 근거 |
|---|---|---|
| 도메인 단위·통합(메모리 저장소) | **PASS** | `npx vitest run` 91 files / 1017 tests 통과, 실패 0 |
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
| `npx vitest run` | files 91, tests 1017, passed 1017, failed 0 (인증 계층 추가 후 재실행. 아래 디렉터리별 표는 21e22e3 기준 JSON 집계에 auth 변경만 반영) |
| `npx tsc --noEmit` | 출력 없음(오류 0) |
| 정적 점검: `git ls-files` 파일명(.env·secret·credential·pem·key) | 해당 없음 |
| 정적 점검: `src tests openapi implementation package.json`에서 JWT·키 패턴, `ordering-dev`·`testBookshare` 프로젝트 ID, `service_role` grep | 해당 없음 |
| 정적 점검: `src`에서 `process.env`·`fetch(`·`http(s)://` grep | 해당 없음 |

디렉터리별 테스트(JSON 보고서 집계):

| 디렉터리 | 파일 | 테스트 |
|---|---|---|
| auth | 4 | 27 |
| errors | 1 | 8 |
| http | 3 | 41 |
| idempotency | 2 | 53 |
| openapi | 2 | 26 |
| order | 8 | 108 |
| procurement | 16 | 362 |
| inventory | 26 | 244 |
| payment | 11 | 59 |
| fulfillment | 2 | 16 |
| notification | 6 | 27 |
| closure | 4 | 15 |
| cancellation | 5 | 25 |
| reopening | 1 | 6 |
| **합계** | **91** | **1017** |

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
| 인증·계정 ST-A | — | A05·A08 일부(주체 도출·행위자 주입) | A01~A04, A06, A07 |
| 도서·공급처 ST-B | — | — | 전부 |

**PARTIAL의 의미:** 도메인 규칙은 구현·테스트했으나 아래 한계 중 하나가 남은 것이다. 항목별 한계는 `testing/test_matrix.csv`의 notes에 있다.
- ST-O05/O06: 공급처 의무는 `supplierObligations`로 부분 처리(§9). 미응답·거절 판정은 없음.
- ST-O07/O08: 공급처 외부 의무 차단(`EXTERNAL_OBLIGATION_OPEN`)은 선택 의존성을 연결해야 동작.
- ST-O10: 근거는 결제 보정·수령 정정 두 가지.
- ST-P02/P09/P11: 배정 자동 해제 없음, 부분 해제 없음, 재납품 약속의 새 의무 기록 없음.
- ST-F02: Owner 단일 명령. 정정 직후 안내·결제 영향 점검 없음.
- ST-Y05: 과수납 사유만. ST-Y07: 수동 증빙 모델의 시도 결과 기록·UNKNOWN 예약·조회 해소만.

**P0 범위의 미구현 중 릴리스에 영향이 큰 것:** 인증·테넌트·직원 관리(ST-A01~A08), 도서·공급처·템플릿 관리(ST-B01~B05). 이 외 P0 상태 전이의 도메인 로직은 모두 PASS 또는 PARTIAL이 되었다(주문 보류·가격 변경·초안 폐기는 정책 미승인 또는 범위 밖).

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
| 권한 모델 | **부분 완화** | `src/auth`의 `resolvePrincipal`·`bindActor`·`authorizedActions`가 역할·행위자·테넌트·SYSTEM 실행자를 주체에서 주입한다(요청 값은 무시, 구조 테스트로 누락 방지). 단 외부 진입점이 도메인 함수를 직접 호출하면 우회되고, Staff 수준의 행위자 이름 필드(`recordedBy` 등)는 아직 바인딩하지 않았으며, JWT 서명 검증·서버가 없다. 원래 위험(`actorRole`·`executedBy`가 요청 값이라 위조 가능)은 도메인 함수 자체에는 그대로 남아 있다. `SYSTEM` 전용 명령도 동일 |

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

테스트는 968 → 1005개(+37), 파일은 76 → 88개(+12)다. 그 뒤 인증·권한 계층(§10)으로 1017개, 91 files가 되었다.

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

`src/auth`에 다음을 추가했다. 테스트 12개(`tests/auth/resolvePrincipal`·`bindActor`·`authorizedActions`).

| 구성 | 역할 |
|---|---|
| `resolvePrincipal` | 검증이 끝난 신원(userId·tenantId·sessionExpiresAt)에서 USER 주체를 만든다. 역할은 멤버십에서 온다. 세션 만료·형식 오류는 UNAUTHENTICATED, 비활성·타 테넌트·비멤버는 같은 FORBIDDEN. 멤버십은 매 호출 다시 읽어 직원 비활성화가 즉시 반영된다(ST-A05, ST-A08) |
| `createSystemPrincipal` | 서버 내부 업무용 SYSTEM 주체 |
| `bindActor` | 명령의 `tenantId`·역할·행위자 이름·`executedBy`를 요청 본문이 아니라 주체에서 주입하고(위조 값은 덮어씀), 허용되지 않은 주체는 명령을 호출하기 전에 FORBIDDEN으로 거부 |
| `authorizedActions` | 역할 또는 SYSTEM 실행자를 요청으로 받는 19개 명령을 바인딩한 모음. 구조 테스트가 `actorRole`·`executedBy`를 받는 명령 파일이 이 모음에서 빠지면 실패시킨다 |

**남은 한계**
- 외부 진입점이 `authorizedActions` 대신 도메인 함수를 직접 호출하면 우회된다. 진입점 규약과 서버 조립에서 강제해야 한다.
- Staff 수준의 행위자 이름 필드(`recordedBy`·`receivedBy`·`requestedBy` 등)를 받는 명령은 아직 바인딩하지 않았다. 감사 귀속이 위조될 수 있다.
- JWT 서명 검증·키 관리·서버가 없다. `resolvePrincipal`은 검증이 끝난 신원을 입력으로 받는다고 가정한다.
- ST-A01~A04(이메일 인증·서점 개설·초대·만료/철회), 직원 비활성화·복구 명령 자체, ST-A06/A07은 구현하지 않았다. 마지막 Owner 보호도 없다.

