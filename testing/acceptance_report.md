# 통합 인수 보고서 (10단계)

작성일: 2026-11-24 · 기준 커밋: `4ece379b51185a6550558a01304c2b71ff8e5636` (`main`, `origin/main`과 동일, 작업 트리 변경 없음 — 이 보고서와 `release/` 산출물 추가 전 상태)
환경: Windows 11, Node v24.18.0, npm 12.0.0, TypeScript 7.0.2, vitest 5.1.1.
상세 항목별 판정은 `testing/test_matrix.csv`에 있다. 이 문서는 요약·증거·한계를 기록한다.

## 0. 최종 판정

| 영역 | 판정 | 한 줄 근거 |
|---|---|---|
| 도메인 단위·통합(메모리 저장소) | **PASS** | `npx vitest run` 76 files / 968 tests 통과, 실패 0 |
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
| `npx vitest run --reporter=json` | files 76, tests 968, passed 968, failed 0, pending 0 |
| `npx tsc --noEmit` | 출력 없음(오류 0) |
| 정적 점검: `git ls-files` 파일명(.env·secret·credential·pem·key) | 해당 없음 |
| 정적 점검: `src tests openapi implementation package.json`에서 JWT·키 패턴, `ordering-dev`·`testBookshare` 프로젝트 ID, `service_role` grep | 해당 없음 |
| 정적 점검: `src`에서 `process.env`·`fetch(`·`http(s)://` grep | 해당 없음 |

디렉터리별 테스트(JSON 보고서 집계):

| 디렉터리 | 파일 | 테스트 |
|---|---|---|
| auth | 1 | 15 |
| errors | 1 | 8 |
| http | 3 | 41 |
| idempotency | 2 | 53 |
| openapi | 2 | 26 |
| order | 8 | 108 |
| procurement | 11 | 344 |
| inventory | 25 | 241 |
| payment | 9 | 53 |
| fulfillment | 1 | 11 |
| notification | 6 | 27 |
| closure | 3 | 14 |
| cancellation | 3 | 21 |
| reopening | 1 | 6 |
| **합계** | **76** | **968** |

## 2. P0 요구사항 추적

추적 단위는 STBR 상태 전이(ST-*)다. 요구사항 ID(FRD)와의 1:1 추적표는 FRD 전체를 읽지 않아 만들지 못했다(한계). 전이별 판정과 근거 테스트는 `testing/test_matrix.csv` 참조.

| 구분 | 구현(PASS) | 부분(PARTIAL) | 미구현 |
|---|---|---|---|
| 주문 ST-O | O01, O03 | O05, O07, O10 | O02, O04, O06, O08, O09 |
| 조달 ST-P | P01, P03~P08, P10 | — | P02, P09, P11 |
| 입고·배분·재고 ST-R/I | R01~R07, I01~I06 | — | — |
| 취소 처분 ST-C | C01~C09 | — | — |
| 안내 ST-M | M01~M06 | — | M07(P1) |
| 수령 ST-F | F01 | — | F02, F03(P1) |
| 결제·환급 ST-Y | Y01~Y04, Y06 | Y05 | Y07, Y08·Y09(P2) |
| 인증·계정 ST-A / 도서·공급처 ST-B | — | — | 전부 |

**P0 범위의 미구현 중 릴리스에 영향이 큰 것:** 전량 취소·취소 종결(ST-O06/O08), 수령 정정(ST-F02), 인증·테넌트·직원 관리(ST-A), 도서·공급처·템플릿 관리(ST-B), 환급 실패 처리(ST-Y07).

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
| 권한 모델 | **위험** | `actorRole`·`executedBy`가 요청 값이라 서버가 신원에서 도출하지 않으면 위조 가능. `SYSTEM` 전용 명령도 동일 |

## 5. 동시성에 대한 정직한 기록

동시성 관련 테스트는 모두 **같은 프로세스에서 순차 호출**한 것이다. 이 테스트들은 "한도 검증이 누적 합산을 사용한다"는 것을 보이지만 **두 요청이 겹치는 경합 조건을 재현하지 못한다.** 해당 항목: 마지막 1권 예약·인도, 환급 요청 중복 방지, 취소 요청 잠금과 인도, 중복 안내·중복 결제 거래, 종결 실행의 version 검사. 진짜 동시성은 DB의 잠금·조건부 갱신·유일 제약과 두 독립 연결이 필요하다.

## 6. 원자성에 대한 정직한 기록

복합 명령(취소 적용, 환급 승인, 인도, 재배분, 종결 실행, 재개)은 "모든 검증을 통과한 뒤 연속 저장" 방식이다. 검증 실패 시 아무것도 남지 않음은 테스트로 확인했으나, **저장 도중 실패를 주입해 이미 쓴 기록을 되돌리는 롤백은 구현·검증하지 못했다.** 감사 기록(audit)도 별도 필드·저장소로 구현하지 않았다.

## 7. 릴리스 차단 조건(분리 보고)

`release/go_no_go.md`에 미승인 정책, 법률·YES24 권한, 결제 계약, 개인정보 보존으로 분리해 나열했다.

## 8. 한계

- FRD·ERD·SFS·API V2.2·RLS V2.2 전체를 단계별로 읽지는 못했다(각 단계 보고서의 "읽지 않은 문서" 참조). 요구사항 ID 단위 추적표는 만들지 못했다.
- 이 단계에서 새 기능을 구현하거나 기존 코드를 변경하지 않았다. 산출물은 `testing/`과 `release/` 문서뿐이다.
