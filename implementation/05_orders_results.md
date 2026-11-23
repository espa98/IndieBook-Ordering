# 05단계 결과 보고 — 주문 등록·목록·상세·확정

작성 기준 커밋: `b99c713` (main). 이 문서는 실제로 실행해 확인한 것과 그렇지 않은 것을 구분해 기록한다.
(이전 버전은 `64e407c` 기준이었고, 오류 코드 구조화 이후 이 버전으로 갱신했다.)

## 0. 한 줄 요약

주문 생성·확정·목록·상세의 **도메인 로직, 권한 적용 진입점, 구조화된 오류(`AppError`)**를 메모리 저장소 기준으로 TDD 구현했고 테스트 108개가 통과한다. **DB(RPC·RLS)·HTTP 라우터·`AppError`의 HTTP 응답 변환·OpenAPI·JWT 검증·동시성은 구현·검증하지 않았다.** 격리 테스트 DB가 없어 DB 계층 항목은 BLOCKED다.

## 1. 읽은 문서와 충돌·미결정 목록

### 1.1 실제로 읽은 문서
- `Docs/README.md`, `Docs/Claude Code 개발지침.md`
- `BookFlow_Ordering_ClaudeCode_단계별프롬프트_V1.0/00, 01, 02, 05`, `README.md`, 루트 `01_프로젝트_진단_및_요구사항_기준선.md`
- `Docs/05_API_Security/API_명세서_V2.2.md` (주문 관련 행, 오류 코드, 멱등·인증 규칙)
- `Docs/02_Policies`의 OPDS(DEC-13 등)·STBR(ST-O01~03, BR-T06, 오류 코드 제안) 중 주문·권한 관련 항목만 검색해 확인
- `Docs/05_API_Security/RLS_정책설계_V2.2.md` 중 membership·JWT 관련 항목

**읽지 않은 문서 (한계):** FRD ORD 절 전체, Use Case 주문 절 전체, ERD, 구현현황표 본문, SFS는 검색 일치 부분만 보았다. 따라서 아래 "문서 근거"는 읽은 범위 안에서만 유효하다. `Docs/README.md`가 요구한 "기준 문서 간 불일치 분석"은 전체를 수행하지 않았다.

### 1.2 문서 간 충돌
| 항목 | 내용 | 처리 |
|---|---|---|
| 인증·권한 오류 코드 | API V2.2는 `UNAUTHENTICATED`/`FORBIDDEN`, STBR 제안은 `AUTH_REQUIRED`/`MEMBERSHIP_INACTIVE`/`ACCESS_DENIED` | API V2.2를 따름. STBR 항목은 "오류 코드 제안"이고 도메인이 이미 V2.2 코드를 사용 중. 비활성 멤버도 `FORBIDDEN` |
| 입력 검증 오류 코드 | API V2.2는 `VALIDATION_ERROR`, STBR 제안은 `VALIDATION_FAILED` | API V2.2를 따름 (`VALIDATION_ERROR`, 400) |
| 업무 규칙 위반 코드 | API V2.2는 `BUSINESS_INVARIANT`(422), STBR 제안은 `INVALID_TRANSITION` | API V2.2를 따름. 재확정, 품목 없는 확정, 확정된 주문에 품목 추가가 여기에 해당. 이 매핑(어떤 위반이 이 코드인지)은 문서에 명시된 것이 아니라 제가 정했다 |
| 우선순위 해석 | 공통 안전규칙은 "OPDS > STBR > FRD/UC > ERD/API/RLS 제안" | 위 오류 코드는 승인 정책이 아니라 제안끼리의 충돌이라 일관성이 높은 쪽 선택. 확정이 필요하면 사용자 결정 요망 |

### 1.3 문서에 정의가 없어 정한 것
**사용자가 결정**
- 목록 기본 `limit` = 20
- `limit` > 100은 잘라서 반환하지 않고 `VALIDATION_ERROR`로 거부
- 품목 0개 빈 초안 생성 허용

**제가 가정 (사용자 확정 안 받음)**
- 표시번호 형식 = 단순 정수. "단순 정수로 시작해도 될까요?"라고 물었으나 명시적 답 없이 "계속 진행"으로 넘어갔으므로 확정이 아니다
- 초안의 초기 `version` = 1
- `unitPriceKrw` `"0"` 허용, 앞자리 0·음수·소수·공백·숫자 타입 거부
- 목록 정렬 방향 = 최신순(`(createdAt, id)` 내림차순). 문서는 정렬 키만 명시
- `status` 필터의 `null`은 "필터 없음"이 아니라 잘못된 값
- 이미 확정된 주문을 **다른 멱등키**로 재확정하면 `BUSINESS_INVARIANT`(422). 어떤 위반이 이 코드인지는 문서에 명시가 없어 제가 매핑
- `issueDisplayNumber` 누락은 서버 설정 오류라 `AppError`가 아닌 일반 `Error`로 둠(400으로 오해되지 않게). HTTP 계층에서 `AppError`가 아닌 오류를 500으로 처리한다는 전제이며 이 규칙은 아직 구현·확정되지 않음
- `AppError`의 `detail` 문자열(입력 이름·규칙 설명)을 HTTP 응답에 그대로 노출할지는 미정. 현재는 사용자 데이터를 담지 않음
- `confirmOrder` 내부 검증 순서: `expectedVersion` 필수 → `issueDisplayNumber` 필수 → DRAFT 여부 → 품목 1개 이상 → 버전 일치
- 예외가 난 요청의 멱등 결과는 저장하지 않음(재시도 허용). 문서는 "실패 결과 보존 정책은 별도 운영 결정"으로 남김
- 허용 `status`는 현재 구현된 `DRAFT`, `CONFIRMED`뿐. STBR의 `HELD` 등은 미구현

### 1.4 미승인·보류 정책
DEC-08/15/16, D22/29, DEC-12(개인정보 보존·삭제)는 건드리지 않았다. 고객 정보(개인정보)를 다루는 필드는 아직 도메인에 없다.

## 2. 변경 파일

커밋 12개. 초기 문서 `ad5d008` 이후 11개: 코드 9개, 문서 1개(이 보고서의 이전 버전), 설정 1개(`.gitignore`에 `.vitest/` 추가).

**프로덕션 (`src/`)**
| 파일 | 역할 |
|---|---|
| `errors/AppError.ts` | `AppError(code, detail?)`: 코드에서 HTTP 상태 결정(400/401/403/404/409/422), `message`는 `"CODE"` 또는 `"CODE: detail"` |
| `order/createDraftOrder.ts` | DRAFT 주문 생성(UUID, tenantId, version 1, createdAt, `now` 주입) |
| `order/addOrderLine.ts` | 품목 추가(수량 정수 ≥ 1, 단가 10진 정수 문자열, DRAFT에서만) |
| `order/confirmOrder.ts` | 확정(expectedVersion 필수, BigInt 합계, 표시번호 주입, 재확정 거부) |
| `order/confirmOrderService.ts` | 저장소 조회→확정→저장, 멱등 감쌈 |
| `order/createOrderService.ts` | 생성 서비스, 멱등 감쌈 |
| `order/listOrders.ts` | 목록(테넌트 격리, 안정 커서, limit, status 필터) |
| `order/getOrder.ts` | 상세(필드 선택 반환, 타 테넌트는 `NOT_FOUND`) |
| `order/orderApi.ts` | 권한 적용 진입점 `guarded(...)` |
| `auth/authorizeTenantAccess.ts` | 인증·활성 membership 검사 |
| `idempotency/executeIdempotent.ts` | `tenant+operation+key` 스코프 멱등 실행 |

**테스트 (`tests/`)** 11개 파일 + 헬퍼 3개(`inMemoryOrderRepository`, `inMemoryMembershipRepository`, `thrown`).
**설정** `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`.

## 3. 실행한 명령과 실제 결과

| 명령 | 결과 |
|---|---|
| `npx vitest run` | Test Files 11 passed, Tests **108 passed** |
| `npx tsc --noEmit` | 오류 없음 |

파일별 테스트 수: authorizeTenantAccess 15 · AppError 7 · executeIdempotent 4 · addOrderLine 16 · confirmOrder 14 · confirmOrderService 5 · createDraftOrder 4 · createOrderService 6 · getOrder 3 · listOrders 29 · orderApi 5 (합계 108).

**실행하지 않은 것:** lint(설정 없음), 빌드, CI(없음), 커버리지 측정.

### 3.1 TDD 준수에 대한 정직한 기록
- 모든 기능은 실패하는 테스트(RED)를 먼저 확인한 뒤 구현했다.
- **RED 없이 통과한 "특성화(회귀 보호) 테스트"**가 있다. 새 동작을 이끈 것이 아니라 이미 구현된 동작을 고정한다.
  - `listOrders`: `limit` 경계값 1·100 허용, 유효한 `status` 허용, 같은 시각 항목이 페이지 경계에 걸린 순회
  - `confirmOrderService`: 같은 키·다른 본문 `IDEMPOTENCY_CONFLICT`
  - `createOrderService`: 같은 키·다른 품목 충돌, 잘못된 품목 전체 거부, 빈 초안 허용
  - `orderApi`: 비활성화된 직원의 같은 키 재시도 차단
  - `confirmOrder`: `issueDisplayNumber` 누락이 `AppError`가 아님을 고정
- 호출 계약이 바뀔 때(`expectedVersion`·`issueDisplayNumber`를 필수로 변경) 기존 테스트의 **호출부만** 수정했고 검증 내용·기대값은 바꾸지 않았다.
- 오류 코드 구조화 단계에서는 `message` 형식을 유지해, 그 이전에 있던 83개 테스트의 **검증 내용은 수정하지 않고** 새 테스트(25개)만 추가했다. 기존 테스트 파일에는 import와 새 테스트만 더했다.
- 변이 실험: `createOrder`에서 권한 검사를 서비스 뒤로 옮기자 "저장되지 않는다" 테스트가 실패했다(순서 보호 확인). 같은 변이에서 재시도 테스트는 통과했는데, 그 테스트는 순서가 아니라 "이전 결과를 받아가지 못함"이라는 외부 결과를 보호하기 때문이다. 변이는 되돌렸다.
- 작업 중 제 실수 세 건을 바로잡았다: (1) 기존 `.gitignore`를 덮어썼다가 커밋 전에 복원, (2) 테스트 없이 넣은 `NOT_FOUND`·품목 복사 분기를 제거하고 테스트 후 다시 구현, (3) 오류 테스트의 `it.each` 제목 형식 오타(`%s %i`가 엉뚱한 인자에 대응)를 구현 전에 수정.

## 4. 구현 현황 (설계·구현·테스트 구분)

| 항목 | 상태 |
|---|---|
| 주문 생성(초안, 멱등) | 구현, 메모리 저장소 테스트 통과 |
| 주문 확정(expectedVersion, 합계, 표시번호, 멱등) | 구현, 메모리 테스트 통과 |
| 목록(안정 커서, limit 20/1~100, status 필터) | 구현, 메모리 테스트 통과 |
| 상세(타 테넌트 비노출) | 구현, 메모리 테스트 통과 |
| 인증·활성 membership·Owner/Staff 허용 | 구현, 메모리 테스트 통과 |
| 비활성 직원 새 요청·재시도 차단(BR-T06) | 구현, 메모리 테스트 통과 |
| 구조화된 오류(`AppError`, API V2.2 코드·HTTP 상태 매핑) | 구현, 단위 테스트 통과. **응답으로 변환하는 계층은 없음** |

**오류 매핑 (API V2.2 기준)**
| HTTP | 코드 | 발생 위치 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `quantity`·`unitPriceKrw`·`tenantId`·`expectedVersion`·`limit`·`cursor`·`status` |
| 401 | `UNAUTHENTICATED` | 인증 없음 |
| 403 | `FORBIDDEN` | 비멤버·타 테넌트·없는 테넌트·비활성 멤버(구별 불가) |
| 404 | `NOT_FOUND` | 없는 주문, 타 테넌트 주문(구별 불가) |
| 409 | `IDEMPOTENCY_CONFLICT` | 같은 키·다른 본문 |
| 409 | `VERSION_CONFLICT` | `expectedVersion` 불일치 |
| 422 | `BUSINESS_INVARIANT` | 재확정, 품목 없는 확정, 확정된 주문에 품목 추가 |
| (500 전제) | 일반 `Error` | `issueDisplayNumber` 누락(서버 설정 오류) |

## 5. 미구현 및 미실행 테스트

**BLOCKED (격리 DB 필요, 안전 규칙상 진행 불가)**
- DB 마이그레이션, RPC, RLS, 실제 `auth.uid()`·membership 헬퍼 검증
- 서점별 표시번호의 **실제 고유성·재사용 금지**(현재는 주입한 가짜 발급기)
- **동시 확정에서 한 건만 성공** (메모리 구현으로는 의미 있게 검증 불가)
- **감사 로그 롤백 테스트**(프롬프트 요구) — 감사 로그 자체가 없음
- 멱등 저장소의 영속성·경쟁 상태(DB 유일 제약 필요)
- 기존 `ordering_v2_command` 레거시 **회귀 테스트**(프롬프트 요구) — 레거시 접근 없음

**미구현 (코드로 가능하나 하지 않음)**
- `HTTP /v1` 라우터, `openapi/ordering.yaml` — **미배포**로 표기
- JWT 검증. 현재 `userId`는 호출자가 준 값을 그대로 신뢰
- `AppError`를 HTTP 응답(상태·본문)으로 변환하는 계층, `AppError`가 아닌 오류의 500 처리, `detail` 노출 정책
- 고객 스냅샷, `HELD`(ST-O02) 보류/재개, 역할별 응답 필드 제한, 목록 요약의 `createdAt`
- `status` 필터와 커서 조합 테스트
- 서비스 직접 호출 시 권한 우회: 서비스·`authorizeTenantAccess`가 모두 export되어 있고 진입점만 쓰도록 강제하는 장치가 없음
- 프롬프트 테스트 목록 중 "누락/초과 입력"은 일부만 해당(수량·가격·limit·cursor 검증은 있으나 필드 누락·과대 입력 전반은 아님)

## 6. 다음 단계 승인 게이트

자동으로 다음 단계로 진행하지 않는다. 사용자 확인이 필요한 항목:

1. **오류 코드 이름**: API V2.2 기준으로 구조화까지 끝냈다. STBR 제안 이름(`VALIDATION_FAILED`·`INVALID_TRANSITION`·`AUTH_REQUIRED` 등)으로 바꾸려면 `AppError`의 코드 표와 관련 테스트를 고쳐야 한다(1.2). 이 기준을 유지할지 확인 필요
2. **제가 가정한 값 확정**: 표시번호 형식, 초기 `version`=1, `unitPriceKrw` `"0"` 허용, 정렬 방향, `BUSINESS_INVARIANT` 매핑 범위(1.3)
3. **`detail` 노출 정책**: 오류 응답 본문에 `detail`을 포함할지
4. **격리 테스트 DB 제공·사용 승인**: 승인 전에는 SQL 적용과 실DB 테스트 불가. DB 계층 항목(5번 BLOCKED)이 모두 여기에 묶여 있다
5. 다음 작업 선택: `AppError`→HTTP 변환 계층 / OpenAPI 초안 / 06단계(조달·발주) 진입
