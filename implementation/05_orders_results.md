# 05단계 결과 보고 — 주문 등록·목록·상세·확정

작성 기준: 커밋 `0981e76`(06단계 완료 시점) 위에 **06단계로 바뀐 05 범위의 사실을 반영해 갱신**한 상태(이 보고서와 같은 커밋에 포함). 이 문서는 실제로 실행해 확인한 것과 그렇지 않은 것을 구분해 기록한다.
(이전 버전: `64e407c` → `b99c713` → `f29e09f` → `a092ad9` → `12a5b0e` → `fbc018d` 기준. 06단계 조달·발주의 내용은 `implementation/06_procurement_results.md`를 본다.)

## 0. 한 줄 요약

주문 생성·확정·목록·상세의 **도메인 로직, 권한 적용 진입점, 구조화된 오류(`AppError`), HTTP 응답 변환(`toErrorResponse`)과 성공·오류 어댑터(`handle`), OpenAPI 3.1 계약 초안과 계약 테스트, 요청 입력 검증, 서버 부여 품목 식별자(`lineId`)**를 메모리 저장소 기준으로 TDD 구현했고 05단계 범위의 테스트 207개가 통과한다(저장소 전체는 06단계 포함 588개, 3번). **실제 HTTP 서버·라우터, 요청 파싱 계층(요청 최상위 필드 검증·JWT·경로 파라미터), DB(RPC·RLS), 동시성은 구현·검증하지 않았다.** 이전 버전에서 기록한 "계약과 구현의 불일치 6건"은 모두 수정했다(5번). 격리 테스트 DB가 없어 DB 계층 항목은 BLOCKED다.

### 이번 갱신에서 바뀐 것 (06단계 이후)
06단계를 진행하면서 **05 범위에도 영향을 준 변경과 발견**이 있어 이 보고서를 갱신했다. 원문은 보존하고 아래 3가지를 반영했다.
1. **주문 품목에 서버 부여 `lineId` 추가**(`8c4c75f`). 06단계의 N:M 배분이 품목 식별자를 필요로 해서 05의 도메인·OpenAPI를 수정했다. 05 테스트의 기대값 4줄이 바뀌었다(3.1).
2. **멱등 본문 비교의 테스트 약점 발견·수정**. 06단계의 변이 스캔이 05 코드(`confirmOrderService`)에서도 같은 빈틈을 찾았다(3.1).
3. **오래된 서술 정정**: "다음 단계는 06 진입"이던 승인 게이트, "취소·발주는 05 밖"이던 미구현 목록.

## 1. 읽은 문서와 충돌·미결정 목록

### 1.1 실제로 읽은 문서
- `Docs/README.md`, `Docs/Claude Code 개발지침.md`
- `BookFlow_Ordering_ClaudeCode_단계별프롬프트_V1.0/00, 01, 02, 05`, `README.md`, 루트 `01_프로젝트_진단_및_요구사항_기준선.md`
- `Docs/05_API_Security/API_명세서_V2.2.md` (주문 관련 행, 오류 코드, 멱등·인증 규칙, 공통 계약)
- `Docs/02_Policies`의 OPDS(DEC-13 등)·STBR(ST-O01~03, BR-T06, 오류 코드 제안) 중 주문·권한 관련 항목만 검색해 확인
- `Docs/05_API_Security/RLS_정책설계_V2.2.md` 중 membership·JWT 관련 항목
- 오류 응답 본문 형식을 `Docs` 전체에서 검색했으나 **정의가 없음**(상태·코드 매핑만 있음)을 확인

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
- 오류 응답 본문 형식 = `{ error: { code, message } }`
- 오류의 `detail`은 **400 `VALIDATION_ERROR`에만** 응답에 노출, 나머지 코드는 코드별 고정 문구

**제가 가정 (사용자 확정 안 받음)**
- 표시번호 형식 = 단순 정수. "단순 정수로 시작해도 될까요?"라고 물었으나 명시적 답 없이 "계속 진행"으로 넘어갔으므로 확정이 아니다
- 초안의 초기 `version` = 1
- `unitPriceKrw` `"0"` 허용, 앞자리 0·음수·소수·공백·숫자 타입 거부
- 목록 정렬 방향 = 최신순(`(createdAt, id)` 내림차순). 문서는 정렬 키만 명시
- `status` 필터의 `null`은 "필터 없음"이 아니라 잘못된 값
- 이미 확정된 주문을 **다른 멱등키**로 재확정하면 `BUSINESS_INVARIANT`(422). 어떤 위반이 이 코드인지는 문서에 명시가 없어 제가 매핑
- `issueDisplayNumber` 누락은 서버 설정 오류라 `AppError`가 아닌 일반 `Error`로 둠(클라이언트 잘못 400으로 오해되지 않게). `toErrorResponse`가 이를 500으로 처리한다
- **500 `INTERNAL_ERROR`와 7개 코드의 고정 문구(영어)**: API V2.2의 오류 목록에 없고 클라이언트에 보이는 문구다. 표현·언어는 사용자 확인 필요
  `Invalid request` · `Authentication required` · `Access denied` · `Resource not found` · `Idempotency key was already used with a different request` · `The resource was modified; reload and retry` · `The request violates a business rule` · `Internal server error`
- **OpenAPI 초안에서 제가 정한 값**: 응답 스키마를 `additionalProperties: false`로 둠(명시하지 않은 필드가 응답에 새면 계약 위반), 모든 주문 응답에서 `tenantId` 제외(요청 경로에 이미 있음), `info.version` `0.1.0-draft`, `servers` 미정의, 경로 접두어 `/v1/tenants/{tenantId}`는 API V2.2의 "제안 경로"
- **성공 응답 본문 = `{ data: ... }`**: 문서에 없고 오류 본문(`{ error }`)과 짝을 맞춰 제가 정했다
- 성공 상태 기본 200, 생성은 201. 201은 API V2.2("201 DRAFT, orderId")에 근거, 200은 가정
- `onUnexpectedError` 훅이 던진 예외는 삼키고 응답은 그대로 500 (로깅 실패가 응답을 깨지 않게)
- `handle`은 동기 함수. 현재 도메인이 모두 동기라서이며, 실제 DB 저장소를 붙이면 비동기로 바꿔야 한다
- **입력 검증 정책 (API V2.2 "알 수 없는 필드는 400"·OpenAPI 요청 스키마를 도메인에 적용)**
  - `lines` 원소의 알 수 없는 필드는 조용히 버리지 않고 400. 최상위 필드는 파싱 계층의 몫이라 적용하지 않음(제가 이 범위로 한정)
  - 오류 메시지에 클라이언트가 보낸 필드 이름을 되돌리지 않고 허용 목록만 알림(제가 정함)
  - `bookId`는 문자열이기만 하면 빈 문자열도 허용(스펙이 길이를 제한하지 않아서)
  - `Idempotency-Key`는 공백만 있는 값도 거부, 최대 길이는 문서에 없어 검사하지 않음
  - `expectedVersion`은 1 이상의 정수(스펙 `minimum: 1`)
- 검증 순서: **권한 → (생성) `lines` 형태 → `Idempotency-Key` → 도메인 규칙.** 입력이 잘못되어도 인증 없음은 401, 비활성·비멤버는 403이 먼저다
- `confirmOrder` 내부 검증 순서: `expectedVersion`(1 이상의 정수) → `issueDisplayNumber` 필수 → DRAFT 여부 → 품목 1개 이상 → 버전 일치
- 예외가 난 요청의 멱등 결과는 저장하지 않음(재시도 허용). 문서는 "실패 결과 보존 정책은 별도 운영 결정"으로 남김
- 허용 `status`는 현재 구현된 `DRAFT`, `CONFIRMED`뿐. STBR의 `HELD` 등은 미구현
- **품목 식별자 `lineId`(06단계에서 추가)**: 서버가 `addOrderLine`에서 품목마다 **UUID를 부여**한다. 같은 내용의 품목도 별개의 `lineId`를 가지며 확정 후에도 바뀌지 않는다. **클라이언트가 `lineId`를 지정하면 알 수 없는 필드로 400**이다. 응답의 품목에는 `lineId`가 있다. 형식(UUID)과 "클라이언트 지정 불가" 정책은 문서에 없어 제가 정했다(API V2.2의 취소 요청이 `lineId`를 쓰므로 품목 식별자가 필요했다)

### 1.4 미승인·보류 정책
DEC-08/15/16, D22/29, DEC-12(개인정보 보존·삭제)는 건드리지 않았다. 고객 정보(개인정보)를 다루는 필드는 아직 도메인에 없다.

## 2. 변경 파일

커밋 이력은 `git log` 참조(초기 문서 `ad5d008` 이후 코드·문서·설정 커밋). 05 범위의 마지막 코드 변경은 `lineId` 추가(`8c4c75f`)이고, 그 이후 06단계 커밋은 `src/procurement/`에 있다.

**계약 (`openapi/`)**
| 파일 | 역할 |
|---|---|
| `openapi/ordering.yaml` | OpenAPI 3.1 초안. 엔드포인트 4개(`GET·POST /orders`, `GET /orders/{orderId}`, `POST /orders/{orderId}/confirm`), Bearer JWT, `Idempotency-Key`, 성공·오류 응답 스키마. **구현된 동작만** 기술하고, 도메인이 400으로 강제하는 요청 제약과 아직 강제하지 않는 것을 본문에 구분해 명시. **`lineId` 추가로 품목 스키마를 요청용 `OrderLineInput`(`lineId` 없음, 보내면 400)과 응답용 `OrderLine`(`lineId` 필수·UUID)으로 분리**(하나로 두면 요청에서 `lineId`를 허용하게 되어 계약이 풀린다). 계약 테스트가 먼저 RED로 이를 알려 주었다. **미배포. 06단계 조달·발주 엔드포인트는 포함하지 않는다** |

**프로덕션 (`src/`)**
| 파일 | 역할 |
|---|---|
| `http/handle.ts` | `handle(fn, { successStatus?, onUnexpectedError? })`: 성공이면 `{ status, body: { data } }`, 실패면 `toErrorResponse` 결과. 예외를 던지지 않음. `AppError`가 아닌 오류만 원본을 훅에 전달 |
| `http/toErrorResponse.ts` | `unknown` 오류 → `{ status, body: { error: { code, message } } }`. `instanceof AppError`로 판별, `detail`은 400 `VALIDATION_ERROR`에만 노출, 그 외 `AppError`는 고정 문구, `AppError`가 아니면 500 |
| `errors/AppError.ts` | `AppError(code, detail?)`: 코드에서 HTTP 상태 결정(400/401/403/404/409/422), `detail` 별도 속성, `message`는 `"CODE"` 또는 `"CODE: detail"` |
| `order/createDraftOrder.ts` | DRAFT 주문 생성(UUID, tenantId, version 1, createdAt, `now` 주입). **06단계에서 타입 분리:** 입력 `NewOrderLine`(`lineId` 없음)과 저장 `OrderLine`(`lineId` 포함) |
| `order/addOrderLine.ts` | 품목 추가(DRAFT에서만). 알 수 없는 필드 거부, `bookId` 문자열, 수량 정수 ≥ 1, 단가 10진 정수 문자열. **06단계에서 추가:** 품목마다 서버가 UUID `lineId`를 부여하고 입력 필드를 명시적으로 복사(입력 객체 불변) |
| `order/confirmOrder.ts` | 확정(BigInt 합계, 표시번호 주입, 재확정 거부). **이번에 변경:** `expectedVersion`을 1 이상의 정수로 검증(0·소수·문자열·`null`은 400) |
| `order/confirmOrderService.ts` | 저장소 조회→확정→저장, 멱등 감쌈 |
| `order/createOrderService.ts` | 생성 서비스, 멱등 감쌈. `lines`가 객체 배열인지 먼저 검증(멱등 처리보다 앞). 요청의 품목 타입은 `NewOrderLine[]` |
| `order/listOrders.ts` | 목록(테넌트 격리, 안정 커서, limit, status 필터) |
| `order/getOrder.ts` | 상세(타 테넌트는 `NOT_FOUND`) + 외부 응답 형태 `toOrderDetail`(필드를 하나씩 골라 반환). **이번에 변환 함수를 꺼내 공용화** |
| `order/orderApi.ts` | 권한 적용 진입점 `guarded(...)`. **이번에 생성·확정 응답도 `toOrderDetail`로 변환**(내부 `Order`가 그대로 새지 않게) |
| `auth/authorizeTenantAccess.ts` | 인증·활성 membership 검사 |
| `idempotency/executeIdempotent.ts` | `tenant+operation+key` 스코프 멱등 실행. **이번에 추가:** 키가 비어 있지 않은 문자열인지 검증(공백만도 거부) |

**테스트 (`tests/`)** 05 범위 16개 파일 + 헬퍼 3개(`inMemoryOrderRepository`, `inMemoryMembershipRepository`, `thrown`). 저장소 전체에는 06단계 테스트가 더 있다(3번).
- `tests/idempotency/payloadCoverage.test.ts`(06단계에서 추가, 05와 공유): 모든 멱등 기능에서 요청 본문의 **필드를 하나씩 바꿔** 같은 키로 보내면 409인지 확인. 05 범위로는 `confirmOrderService`의 `orderId`·`expectedVersion`이 여기에 등록되어 있다. (`createOrderService`의 멱등 본문은 `lines` 하나뿐이고 기존 테스트가 이미 잡았다)
- `tests/openapi/ordering.spec.test.ts`: 스펙이 유효한 OpenAPI 3.1인지, 엔드포인트 4개만 있는지, Bearer 인증과 `Idempotency-Key` 필수인지
- `tests/openapi/ordering.contract.test.ts`: 실제 응답(진입점 + `handle`)을 스펙의 응답 스키마로 검증. 성공 응답과 스펙이 선언한 오류 응답 21종 전체, 그리고 "스펙이 선언한 조합 = 시나리오가 다루는 조합" 정합성

**설정** `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`.
- 개발 의존성 추가(테스트 전용, 런타임 영향 없음): `yaml`, `@apidevtools/swagger-parser`, `ajv`, `@types/node`
- `tsconfig.json`의 `types`를 `["node"]`로 변경(계약 테스트가 파일을 읽기 위함)

## 3. 실행한 명령과 실제 결과

| 명령 | 결과 |
|---|---|
| `npx vitest run` (저장소 전체, 06단계 포함) | Test Files 28 passed, Tests **588 passed** |
| `npx tsc --noEmit` | 오류 없음 |

05 범위 16개 파일의 테스트 수: authorizeTenantAccess 15 · AppError 8 · handle 6 · orderHttp(통합) 21 · toErrorResponse 14 · executeIdempotent 9 · openapi 계약 23 · openapi 스펙 3 · addOrderLine 29 · confirmOrder 20 · confirmOrderService 5 · createDraftOrder 4 · createOrderService 13 · getOrder 3 · listOrders 29 · orderApi 5 (**합계 207**). 이전 버전의 204에서 `addOrderLine`이 `lineId` 테스트 3개만큼 늘었다. 나머지 381개(조달 11개 파일 344 + `payloadCoverage` 37)는 06단계 범위다.

**실행하지 않은 것:** lint(설정 없음), 빌드, CI(없음), 커버리지 측정, 실제 HTTP 서버를 통한 요청(서버 없음).

### 3.1 TDD 준수에 대한 정직한 기록
- 모든 기능은 실패하는 테스트(RED)를 먼저 확인한 뒤 구현했다.
- **RED 없이 통과한 "특성화(회귀 보호)·통합 테스트"**가 있다. 새 동작을 이끈 것이 아니라 이미 구현된 동작을 고정한다.
  - `listOrders`: `limit` 경계값 1·100 허용, 유효한 `status` 허용, 같은 시각 항목이 페이지 경계에 걸린 순회
  - `confirmOrderService`: 같은 키·다른 본문 `IDEMPOTENCY_CONFLICT`
  - `createOrderService`: 같은 키·다른 품목 충돌, 잘못된 품목 전체 거부, 빈 초안 허용
  - `orderApi`: 비활성화된 직원의 같은 키 재시도 차단
  - `confirmOrder`: `issueDisplayNumber` 누락이 `AppError`가 아님을 고정
  - `handle`: 성공·`AppError`에서 훅 미호출, 훅이 예외를 던져도 500 유지
  - `orderHttp`(통합 21건): 진입점 + `handle`을 처음부터 끝까지 연결해 확인. 새 프로덕션 코드 없이 통과했고, 계층 사이 연결 오류가 없음을 보여 준다. 그중 14건은 계약-구현 불일치 수정 후 HTTP 수준 회귀 확인용(단위 테스트가 먼저 RED였고 이 14건은 처음부터 통과)
  - `addOrderLine`: `bookId`가 문자열이면 빈 문자열도 허용한다는 보호 테스트
  - `ordering.contract`의 오류 응답 21종 + 정합성 검사: 처음부터 통과(RED 없음)
  - 반면 `ordering.contract`의 **성공 응답 검증은 진짜 RED**였다: 생성·확정 응답에 스펙에 없는 `tenantId`가 노출되고 있음을 잡았고, `toOrderDetail`로 고쳤다(서비스 계층과 기존 테스트는 수정하지 않음)
- **계약-구현 불일치 수정은 정식 TDD 사이클 5개**(63~67)로 진행했다. 각각 실패하는 단위 테스트를 먼저 확인한 뒤 구현했다: `expectedVersion` 검증(6케이스 RED), `Idempotency-Key` 검증(5), `lines` 형태(7), 알 수 없는 필드(4), `bookId` 타입(5).
- 이 불일치들은 **실제 실행으로 먼저 확인**했다. 임시 프로브 테스트로 잘못된 요청을 진입점에 보내 결과(500·201·409)를 관찰한 뒤 삭제했다. 첫 프로브는 출력이 비어 원인을 확인하고 결과를 파일로 받아 재실행했다.
- 호출 계약이 바뀔 때(`expectedVersion`·`issueDisplayNumber`를 필수로 변경) 기존 테스트의 **호출부만** 수정했고 검증 내용·기대값은 바꾸지 않았다.
- 오류 코드 구조화, HTTP 변환 계층, OpenAPI 단계에서는 기존 테스트를 **수정하지 않고** 새 테스트만 추가했다. `git diff`로 확인: `64e407c..b99c713`, `b99c713..f29e09f`, `f29e09f..a092ad9`, `a092ad9..12a5b0e`, `12a5b0e..작업 트리` 다섯 구간 모두 테스트 파일의 삭제된 줄이 0개. (**이전 버전의 이 문장은 `fbc018d`까지만 해당한다.**)
- **06단계의 `lineId` 추가(`8c4c75f`)로 05의 기존 테스트 4줄이 바뀌었다.** `git diff fbc018d..HEAD`로 확인: `addOrderLine` 1줄, `createOrderService` 2줄, `getOrder` 1줄(3개 파일). 모두 저장된 품목에 `lineId`가 생겨 **기대값에 `lineId`가 포함되도록 한 변경**이며, 다른 검증 내용을 약화하지 않았다. 다만 "테스트를 고치지 않는다"는 규칙의 예외에 해당하므로 사실대로 기록한다. 새 동작은 새 테스트로 먼저 RED를 확인했고(`addOrderLine`의 `lineId` 3개), OpenAPI 계약 테스트가 요청·응답 스키마 분리를 먼저 RED로 알려 주었다.
- **멱등 본문 비교의 테스트 약점**: 이전 버전의 변이 실험은 05의 멱등 기능에서 모든 요청 필드를 하나씩 바꿔 보지는 않았다. 06단계에서 전 필드 자동 스캔을 하자 `confirmOrderService`의 `orderId` 변경을 잡는 테스트가 없었다(변이 생존). `tests/idempotency/payloadCoverage.test.ts`를 추가해 고쳤고(`expectedVersion`은 이미 잡혔고 `createOrderService.lines`도 기존 테스트가 잡음), 재스캔에서 전부 killed였다. 프로덕션 코드 결함은 아니었고 테스트 공백이었다.
- 변이 실험 열 건(모두 되돌림):
  1. `createOrder`에서 권한 검사를 서비스 뒤로 옮기자 "저장되지 않는다" 테스트가 실패했다(순서 보호 확인). 같은 변이에서 재시도 테스트는 통과했는데, 그 테스트는 순서가 아니라 "이전 결과를 받아가지 못함"이라는 외부 결과를 보호하기 때문이다.
  2. `handle`에서 훅 호출을 `try/catch` 밖으로 꺼내자 "훅이 던져도 500 유지" 테스트 1건만 정확히 실패했다(보호용 테스트가 의미 있음을 확인).
  3. 스펙에서 `Idempotency-Key`의 `required`를 `false`로 바꾸자 해당 스펙 테스트 1건만 실패했다.
  4. 스펙의 오류 코드 목록에서 `INTERNAL_ERROR`를 빼자 500 시나리오 4건만 실패했다.
  5. 스펙에서 `POST /orders`의 409 응답 선언을 지우자 그 시나리오와 정합성 검사만 실패했다.
  6. `expectedVersion` 검증을 예전 방식으로 되돌리자 10건 실패(단위 6 + HTTP 4).
  7. `Idempotency-Key` 검증을 제거하자 8건 실패(단위 5 + HTTP 3).
  8. `lines` 검증을 제거하자 10건 실패(단위 7 + HTTP 3).
  9. 알 수 없는 필드 검사를 제거하자 5건 실패(단위 4 + HTTP 1).
  10. `bookId` 검사를 제거하자 7건 실패(단위 5 + HTTP 2).
  6~10은 실패한 개수가 각 수정을 지키는 테스트 수와 정확히 일치했다.
- 작업 중 제 실수 여섯 건(06단계 갱신에서 발견한 위 문장 오류와 테스트 공백은 별도)을 바로잡았다: (1) 기존 `.gitignore`를 덮어썼다가 커밋 전에 복원, (2) 테스트 없이 넣은 `NOT_FOUND`·품목 복사 분기를 제거하고 테스트 후 다시 구현, (3) 오류 테스트의 `it.each` 제목 형식 오타(`%s %i`가 엉뚱한 인자에 대응)를 구현 전에 수정, (4) 스펙 테스트가 `$ref`를 해석하지 않고 읽어 실패했을 때 원인이 스펙이 아니라 제 테스트임을 확인하고 **기대값은 두고 읽는 방식만** 고침(이후 변이 실험으로 테스트가 유효함을 재확인), (5) 테스트 합계를 암산으로 더하다 두 번 틀렸고(161·196) 스크립트·실행 결과로 바로잡음, (6) 보고서 표에 같은 파일 행을 중복 추가했다가 검사로 발견해 병합.

## 4. 구현 현황 (설계·구현·테스트 구분)

| 항목 | 상태 |
|---|---|
| 주문 생성(초안, 멱등) | 구현, 메모리 저장소 테스트 통과 |
| 주문 확정(expectedVersion, 합계, 표시번호, 멱등) | 구현, 메모리 테스트 통과 |
| 목록(안정 커서, limit 20/1~100, status 필터) | 구현, 메모리 테스트 통과 |
| 상세(타 테넌트 비노출) | 구현, 메모리 테스트 통과 |
| 인증·활성 membership·Owner/Staff 허용 | 구현, 메모리 테스트 통과 |
| 비활성 직원 새 요청·재시도 차단(BR-T06) | 구현, 메모리 테스트 통과 |
| 구조화된 오류(`AppError`) | 구현, 단위 테스트 통과 |
| 오류 → HTTP 응답 변환(`toErrorResponse`) | 구현, 단위 테스트 통과 |
| 성공·오류 어댑터(`handle`)와 진입점 통합 | 구현, 통합 테스트 통과. **실제 HTTP 서버에는 연결되지 않음** |
| OpenAPI 3.1 계약 초안(엔드포인트 4개) | 작성, 스펙 유효성·계약 테스트 통과. **미배포**. 응답 형태는 계약 테스트로 구현과 일치 확인 |
| 응답 형태 통일(`toOrderDetail`) | 구현. 생성·확정·상세가 같은 스키마(`tenantId` 제외) |
| 요청 입력 검증(도메인 계층): `lines`·품목 필드·`Idempotency-Key`·`expectedVersion` | 구현, 단위·HTTP 수준 테스트 통과. 잘못된 입력은 400(500·409·201이 아님), 권한 검사가 먼저 |
| 서버 부여 품목 식별자 `lineId`(06단계에서 추가) | 구현, 단위·계약 테스트 통과. UUID, 클라이언트 지정 시 400, 응답에 포함. 형식·정책은 제가 정한 값 |

**오류 응답 (API V2.2 코드·상태 기준, 본문은 `{ error: { code, message } }`)**
| HTTP | 코드 | 발생 위치 | message |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | `quantity`·`unitPriceKrw`·`bookId`·품목의 알 수 없는 필드·`lines`·`Idempotency-Key`·`tenantId`·`expectedVersion`·`limit`·`cursor`·`status` | `detail` 그대로(없으면 `Invalid request`) |
| 401 | `UNAUTHENTICATED` | 인증 없음 | 고정 문구 |
| 403 | `FORBIDDEN` | 비멤버·타 테넌트·없는 테넌트·비활성 멤버(구별 불가) | 고정 문구 |
| 404 | `NOT_FOUND` | 없는 주문, 타 테넌트 주문(응답 전체가 동일, 통합 테스트로 확인) | 고정 문구 |
| 409 | `IDEMPOTENCY_CONFLICT` | 같은 키·다른 본문 | 고정 문구 |
| 409 | `VERSION_CONFLICT` | `expectedVersion` 불일치 | 고정 문구 |
| 422 | `BUSINESS_INVARIANT` | 재확정, 품목 없는 확정, 확정된 주문에 품목 추가 | 고정 문구 |
| 500 | `INTERNAL_ERROR` | `AppError`가 아닌 모든 오류(예: `issueDisplayNumber` 누락). 원본은 응답에 없음 | `Internal server error` |

## 5. 미구현 및 미실행 테스트

**BLOCKED (격리 DB 필요, 안전 규칙상 진행 불가)**
- DB 마이그레이션, RPC, RLS, 실제 `auth.uid()`·membership 헬퍼 검증
- 서점별 표시번호의 **실제 고유성·재사용 금지**(현재는 주입한 가짜 발급기)
- **동시 확정에서 한 건만 성공** (메모리 구현으로는 의미 있게 검증 불가)
- **감사 로그 롤백 테스트**(프롬프트 요구) — 감사 로그 자체가 없음
- 멱등 저장소의 영속성·경쟁 상태(DB 유일 제약 필요)
- 기존 `ordering_v2_command` 레거시 **회귀 테스트**(프롬프트 요구) — 레거시 접근 없음

**해결한 계약-구현 불일치 (이전 버전에서 "알려진 결함"으로 기록, 실제 실행으로 확인 후 TDD로 수정)**

OpenAPI 스펙의 요청 제약을 구현이 강제하지 않았다. 도메인 함수가 타입이 맞는 입력을 전제로 했기 때문이다. 임시 프로브 테스트로 잘못된 요청을 직접 보내 확인했다.

| 요청 | 스펙(계약) | 수정 전 실제 동작 | 현재 |
|---|---|---|---|
| `lines` 누락·비배열·원소가 객체 아님 | 400 | **500 `INTERNAL_ERROR`** | 400 |
| `Idempotency-Key` 빈 문자열·공백·누락 | 필수, `minLength: 1` | **201 성공으로 처리** | 400 |
| `expectedVersion` 0·음수·소수·문자열·`null` | 정수, 최소 1 → 400 | **409 `VERSION_CONFLICT`** | 400 |
| `lines` 원소의 **알 수 없는 필드** | `additionalProperties: false` → 400 | **201, 저장되고 응답에 그대로 되돌아옴** | 400, 저장 안 함 |
| `bookId`가 숫자·누락 | 문자열, 필수 | **201 성공으로 처리** | 400 |
| `bookId` 빈 문자열 | 제한 없음 | 201 | 201 (스펙과 일치, 보호 테스트로 고정) |

- 우선순위가 높았던 것은 두 가지다. `Idempotency-Key` 누락 통과는 멱등성 보호가 사실상 꺼진다는 뜻이었고, 알 수 없는 필드가 저장·반환되는 것은 나중에 도메인에 의미 있는 필드(예: 권한 관련)가 생기면 클라이언트가 값을 주입하는 통로(mass assignment)가 될 수 있었다.
- 입력이 잘못되어도 인증 없음은 401, 비활성·비멤버는 403이 먼저다(권한이 먼저).
- 오류 메시지에는 클라이언트가 보낸 필드 이름을 되돌리지 않는다.

**미구현 (코드로 가능하나 하지 않음)**
- **실제 HTTP 서버·`/v1` 라우터** — **미배포**. 서버 방식(Edge Functions 또는 별도 백엔드)이 02단계의 사용자 결정 사항이라 아직 정해지지 않음. OpenAPI 초안은 작성했으나 서빙하지 않으며 `servers`도 정의하지 않았다
- OpenAPI에서 제외한 엔드포인트: 06단계에서 도메인 함수로 구현한 공급처 발주·회신·취소 요청 등 05단계 밖의 것(06 함수에는 진입점·권한 적용·OpenAPI가 아직 없다). 고객 스냅샷도 도메인에 없어 스펙에 없다
- **요청 파싱 계층**(HTTP 요청을 도메인 입력으로 바꾸는 곳): `Authorization` JWT 검증, HTTP 헤더·본문 읽기, **요청 최상위의 알 수 없는 필드 400**(API V2.2 공통 계약. 도메인은 이미 파싱된 값을 받아 볼 수 없음), `Idempotency-Key`의 최대 길이, 경로 파라미터(`tenantId`, `orderId`) 형식. 현재 `userId`는 호출자가 준 값을 그대로 신뢰
  (품목 단위 입력 검증은 위에서 도메인에 구현했으므로 이 목록에 포함되지 않는다)
- **서버 로깅 구현체**: `onUnexpectedError` 훅만 있고 실제 로거는 연결하지 않음. 훅을 주입하지 않으면 500의 원인이 어디에도 남지 않는다
- 응답 `requestId`, `handle`의 비동기 지원
- 고객 스냅샷, `HELD`(ST-O02) 보류/재개, 역할별 응답 필드 제한, 목록 요약의 `createdAt`
- `status` 필터와 커서 조합 테스트
- 서비스 직접 호출 시 권한 우회: 서비스·`authorizeTenantAccess`가 모두 export되어 있고 진입점만 쓰도록 강제하는 장치가 없음. **06단계 함수(`src/procurement/`)는 진입점 자체가 없어 권한 검사를 거치지 않고 호출된다**(`tenantId`는 호출자가 준 값을 신뢰)
- 프롬프트 테스트 목록 중 "누락/초과 입력": **누락**은 `lines`·품목 필드·`Idempotency-Key`·`expectedVersion`까지 검증한다. **초과(과대) 입력**은 문서에 상한이 없어 검사하는 코드가 없다(품목 수, 문자열 길이, 금액 자릿수, 본문 크기). 코드 확인 기준이며 별도 테스트는 없다

## 6. 다음 단계 승인 게이트

자동으로 다음 단계로 진행하지 않는다. 사용자 확인이 필요한 항목:

1. **오류 코드 이름**: API V2.2 기준으로 구조화·응답 변환까지 끝냈다. STBR 제안 이름(`VALIDATION_FAILED`·`INVALID_TRANSITION`·`AUTH_REQUIRED` 등)으로 바꾸려면 `AppError`의 코드 표, `toErrorResponse`의 고정 문구 표와 관련 테스트를 고쳐야 한다(1.2). 이 기준을 유지할지 확인 필요
2. **제가 가정한 값 확정**: 표시번호 형식, 초기 `version`=1, `unitPriceKrw` `"0"` 허용, 정렬 방향, `BUSINESS_INVARIANT` 매핑 범위, 성공 본문 `{ data }`와 기본 상태 200, OpenAPI 응답 `additionalProperties: false`(1.3)
3. **500 `INTERNAL_ERROR`와 고정 문구의 표현·언어**(영어): 클라이언트에 노출되는 문구라 확인 필요(1.3)
4. **격리 테스트 DB 제공·사용 승인**: 승인 전에는 SQL 적용과 실DB 테스트 불가. DB 계층 항목(5번 BLOCKED)이 모두 여기에 묶여 있다
5. **서버 방식 결정**(Edge Functions 또는 별도 백엔드, 02단계 요구): 실제 라우터·요청 파싱 계층을 만들기 전에 필요
6. **입력 검증 정책 확인**(1.3): 알 수 없는 필드를 400으로 거부(품목 단위만 적용), 오류 메시지에 클라이언트 필드 이름 비노출, `bookId` 빈 문자열 허용, 공백만 있는 `Idempotency-Key` 거부
7. **과대 입력 상한 결정**: 품목 수·문자열 길이·금액 자릿수·본문 크기의 상한이 문서에 없다. 상한 없이 두면 매우 큰 입력으로 서버 자원을 소모시킬 수 있다
8. 다음 작업 선택: 서버 방식 결정 후 요청 파싱 계층 / 과대 입력 상한(7번 결정 후) / 06 함수의 진입점·권한·OpenAPI 연결. (06단계 조달·발주는 도메인 로직까지 진행했고, 그 승인 게이트는 `implementation/06_procurement_results.md`를 본다)
