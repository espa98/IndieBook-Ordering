# BookFlow Ordering — Bolt.new용 API 연결 가이드 V1.0

작성일: 2026-11-26 · 기준: `openapi/ordering.yaml`(주문 4개)·`openapi/ordering-http.yaml`(나머지 108개), 격리 DB 시험 211개 파일·1650개 테스트 통과

**누구를 위한 문서인가:** `BookFlow_Ordering_BoltNew_단계별프롬프트_V1.0`으로 웹 UI를 만드는 프런트엔드 작업자(Bolt.new). 책임 분리는 그대로다 — *백엔드(이 저장소) = DB·RLS·업무 API·검증, Bolt.new = 반응형 웹 UI·업무 흐름·검증된 API 연결.* 이 문서는 **"서버가 UI에 무엇을 약속하는가"** 를 한곳에 모은 것이고, 필드 단위의 정확한 계약은 항상 `openapi/*.yaml`이 기준이다(이 문서의 예시와 어긋나면 명세가 맞다).

**이 가이드가 말하지 않는 것:** 운영 배포(보류, `release/go_no_go.md` NO-GO), 실제 Supabase 환경 검증(범위 밖으로 정해 둠), 화면 디자인. 아래 모든 동작은 **격리 로컬 Postgres와 직접 서명한 JWT**로 검증했고 실제 Supabase 토큰·키로는 검증하지 않았다.

---

## 1. 먼저 지킬 원칙 (Bolt.new 공통 규칙과 연결)

| 원칙 | 이 서버에서의 의미 |
|---|---|
| 승인된 API만 호출 | 아래 §6의 103개 연산과 `GET /healthz`뿐이다. 문서에 없는 경로를 가정하지 않는다. |
| `service_role` 키 브라우저 노출 금지 | 브라우저는 **사용자 access token(JWT)** 만 보낸다. DB 키·서버 비밀은 서버 환경에만 있다. |
| 권한 판정은 서버가 한다 | 서버가 **매 요청** DB에서 활성 멤버십·역할을 다시 읽는다. 토큰의 역할·서점 claim은 무시한다. UI는 버튼을 숨기는 용도일 뿐, 숨겼다고 안전하지 않다. |
| 미구현·미승인 기능은 성공 처리하지 않는다 | §10의 "서버 없음" 목록은 `DEMO MODE`/비활성으로 표시한다. |
| 금액·수량은 서버 결과가 진실 | 합계·잔액·남은 수량·상태는 서버가 계산해 준다. 클라이언트 계산은 표시·사전 검증에만 쓴다. |
| 확정 거래는 덮어쓰지 않는다 | 수정 API는 없다. 정정·취소·역거래 명령을 쓴다(ST-O04 가격/품목 변경은 정책 미승인으로 서버가 막는다). |

---

## 2. 연결하기

### 2.1 서버 주소와 환경
- 기본 포트 **8080**(`PORT`). 상태 확인은 인증 없이 `GET /healthz` → `{"status":"ok"}`.
- 모든 업무 경로는 `/v1/...`로 시작한다. 서점 범위는 `/v1/tenants/{tenantId}/...`, 서점에 속하기 전의 계정 업무만 `/v1/stores`·`/v1/me/memberships`·`/v1/invitations/accept`다.
- **브라우저에서 호출하려면 서버의 `CORS_ALLOWED_ORIGINS`에 UI 오리진(예: `https://xxx.bolt.host`, `http://localhost:5173`)이 정확히 들어 있어야 한다.** 비어 있으면 브라우저 오리진을 허용하지 않는다(와일드카드·쿠키 없음, 인증은 Bearer 토큰). 허용 헤더는 `authorization, content-type, idempotency-key`, 노출 헤더는 `x-request-id`다.
- 서버 환경 변수·마이그레이션·실행 절차는 `release/new_project_runbook.md`를 따른다(`npm run build` → `node dist/server.mjs`). DB는 **격리 DB**여야 하며 `ordering-dev`·`testBookshare`에는 연결하지 않는다.

### 2.2 인증 (Supabase Auth)
1. UI가 Supabase Auth로 로그인해 `access_token`을 얻는다(로그인·회원가입·비밀번호 재설정·이메일 인증은 **Supabase 담당**, 이 서버에 해당 API가 없다).
2. 모든 요청에 `Authorization: Bearer <access_token>`을 붙인다. 없거나 잘못되면 `/v1/…` 아래의 어떤 경로든(존재하지 않는 경로 포함) 똑같이 **401** `UNAUTHENTICATED`다.
3. 서버가 검증하는 것: 서명(RS256/ES256 공개 키 또는 HS256 비밀), `exp`(만료), `nbf`, `aud == "authenticated"`, `iss`(서버에 설정한 경우), `sub`가 UUID. 알고리즘 혼동(`none` 등)은 거부한다.
4. **서점 개설·초대 수락은 토큰의 최상위 `email` claim이 필요하다**(없으면 403). `user_metadata`의 이메일은 쓰지 않는다. 그 밖의 경로는 이메일이 필요 없다.
5. **401을 받으면** 토큰을 갱신(refresh)하고 요청을 한 번 다시 보낸다. 그래도 401이면 로그인 화면으로 보낸다.

### 2.3 서점 선택 (A-05) — 앱의 첫 호출
```
GET /v1/me/memberships
→ 200 { "data": [ { "tenantId": "…", "tenantName": "책방, 오후 세시", "role": "OWNER" | "STAFF" } ] }
```
- 활성 멤버십만 나온다(비활성은 빠진다). 빈 배열이면 "서점 개설" 또는 "초대 수락" 안내를 보여 준다(`POST /v1/stores`, `POST /v1/invitations/accept`).
- 선택한 `tenantId`는 **클라이언트 상태일 뿐 권한 근거가 아니다.** 이후 모든 호출 경로에 넣고, 어느 호출이든 **403이 오면 서점 목록을 다시 조회**한다(권한이 회수됐을 수 있다).
- 서점 정보·경고일: `GET /v1/tenants/{tenantId}/store`(이름·개설일·`longUnreceivedWarningDays`·내 역할).

---

## 3. 요청 규칙

| 항목 | 규칙 |
|---|---|
| 본문 | JSON 객체, `Content-Type: application/json`. 아니면 **415**. 본문 상한 기본 1 MiB(**413**). |
| **`Idempotency-Key` (POST 필수)** | 1~128자. 없거나 길면 400. **사용자의 한 번의 의도 = 키 하나**(UUID v4 권장). 네트워크 실패·타임아웃 뒤 **같은 키·같은 본문으로 재시도하면 같은 결과**를 돌려주고 중복 실행하지 않는다. 같은 키에 **다른 본문**이면 409 `IDEMPOTENCY_CONFLICT`. 폼을 다시 열어 새로 제출하면 새 키. |
| 본문 필드 | 문서에 있는 필드만 허용한다. **알 수 없는 필드는 400**(행위자·역할·`tenantId`는 보낼 수 없다 — 서버가 토큰에서 정한다). |
| 금액 | **정수 문자열**(`"15000"`). JSON 숫자·소수·음수·앞자리 0·공백 불가. 요청 금액은 15자리 이하. |
| 수량 | JSON 정수. |
| 시각 | **RFC3339 UTC**(`2026-03-04T06:00:00.000Z`). 날짜만·오프셋(`+09:00`) 불가, **미래 시각 불가**(업무가 일어난 시각을 보낸다). |
| 경로 ID | UUID가 아니면 404(공급처 `code`만 소문자·숫자·`-`). |
| 쿼리 | 허용 목록 밖의 쿼리는 400. 불리언 쿼리는 **`true`/`false`만**(`TRUE`·`1`·`yes`는 400). |
| 낙관적 잠금 | 상태가 있는 대상은 `expectedVersion`(현재 `version`)을 함께 보낸다. 다르면 409 `VERSION_CONFLICT`. |

모든 응답에는 `x-request-id`가 있다 — 오류 신고·로그 연결에 화면에 노출할 수 있게 보관한다.

---

## 4. 응답 규칙

- **성공:** `{ "data": … }`. 상태는 201(만들어짐)·200(그 외). 정확한 값은 §6 표의 "성공" 열.
- **오류:** `{ "error": { "code": "…", "message": "…" } }`. `message`는 개발자용 영어 설명이며 **화면 문구는 `code`로 정한다**(서버는 알 수 없는 필드의 이름 같은 요청 값을 오류 본문에 되돌리지 않는다).
- **목록:** `{ "data": { "items": [...], "nextCursor": "…" } }`. `nextCursor`는 **불투명 문자열**이다 — 해석하지 말고 그대로 `cursor` 쿼리에 넣어 다음 페이지를 받는다. 마지막 페이지에는 `nextCursor`가 없다. `limit`은 1~100(기본 20). 필터를 바꾸면 커서를 버리고 처음부터 시작한다.
- 쓰기 응답의 `data`는 변경된 객체(또는 변경 기록)다. **쓰기 성공 뒤에는 목록·상세를 다시 조회**해 서버 상태를 화면에 반영한다(서버 계산값이 바뀔 수 있다).

### 오류 코드와 화면 처리

| 상태 | `code` | 뜻 | UI 처리 |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | 입력 형식·범위·알 수 없는 필드·쿼리 | 필드 오류 표시. 사용자 입력을 유지한다. 알 수 없는 필드 오류는 UI 버그다. |
| 401 | `UNAUTHENTICATED` | 토큰 없음·만료·위조 | 토큰 갱신 1회 → 실패하면 로그인. |
| 403 | `FORBIDDEN` | 활성 멤버가 아님·역할 부족·위임 없음 | "권한 없음" 화면(작업 숨김). **서점 목록 재조회.** 비활성 직원은 즉시 막힌다. |
| 404 | `NOT_FOUND` | 없음 **또는 다른 서점 대상**(구별 불가) | "찾을 수 없음". 존재 여부를 추측해 안내하지 않는다. |
| 405 | `METHOD_NOT_ALLOWED` | 메서드 오류 | UI 버그. |
| 409 | `VERSION_CONFLICT` | 다른 사람이 먼저 바꿨다 | 최신 상태를 다시 읽고 변경 내용을 비교하게 한 뒤 새 `expectedVersion`으로 재제출. |
| 409 | `IDEMPOTENCY_CONFLICT` | 같은 키에 다른 본문 | UI 버그(키 재사용). 새 키로. |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 크기·형식 | UI 버그. |
| 422 | `BUSINESS_INVARIANT` | 업무 규칙 위반(상태 전이·수량 한도·중복·이미 그 상태) | 사유를 사용자에게 설명(`message` 원문 대신 화면별 문구). 재시도해도 같다. |
| 503 | `SERVICE_UNAVAILABLE` | 외부 서비스(YES24 도서 검색)를 지금 쓸 수 없다(미설정·장애·시간 초과·동시 호출 상한) | "도서 검색을 지금 쓸 수 없습니다" + **수기 도서 등록**으로 전환. 같은 요청을 잠시 후 다시 시도할 수 있다. 원인은 서버가 알려 주지 않는다. |
| 500 | `INTERNAL_ERROR` | 서버 오류·**DB 쿼리 시간 초과(기본 10초)** | "잠시 후 다시". **같은 `Idempotency-Key`로 재시도**해도 안전하다. 연속 실패 시 `x-request-id`를 보여 준다. |

**결과 불명확(응답 유실·타임아웃):** 같은 키·같은 본문으로 재전송하면 이미 처리된 경우 같은 결과를 받는다. 재전송 대신 **상세를 조회해** 반영 여부를 확인하는 것도 좋다.

---

## 5. 화면 상태 사전 (배지 이름을 서버 값에서 만든다)

| 대상 | 서버 값 | 화면 표시 가이드 |
|---|---|---|
| 주문 | `status`: `DRAFT`·`CONFIRMED` + 필드 `heldAt`(보류)·`discardedAt`(폐기) | 초안 / **보류**(`heldAt` 있음, 사유 `holdReason`) / **폐기**(`discardedAt`) / 확정. 상태 값은 늘리지 않고 필드로 구별한다. 폐기된 초안은 목록 기본 제외(`includeDiscarded=true`로 포함). 보류·재개·폐기 이력은 `GET /orders/{id}/history`. |
| 결제 | `PENDING`(입력만)·`CONFIRMED`(확인)·`VOIDED`(무효) | 확인 전에는 "완료"로 표시하지 않는다. 주문의 `balanceKrw`(잔액)·`refundRequiredKrw`(과수납)는 서버 값. |
| 안내 대상 | `PENDING`(시도 없음)·`ATTEMPTED`(시도만)·`MANUAL_RECORDED`(완료)·`FAILED`(재안내 필요) | **복사·공유는 발송 완료가 아니다.** 발송 시도와 결과 기록이 따로 있다. |
| 환급 업무 | `REFUND_REQUIRED`·`PARTIAL`·`REFUNDED` | 남은 금액 `remainingKrw`. 미결 요청 `pendingRequests`, 미해소 시도 `unresolvedAttempts`. |
| 발주 | `DRAFT`·`READY`·`SENT`·`ACKNOWLEDGED`·`CANCELLED`·`CLOSED` | 출력과 **실제 전달**은 별개다(`delivery`). |
| 직원 초대 | `PENDING`·`ACCEPTED`·`REVOKED`·`EXPIRED` | 만료는 조회 시각 기준이다. 토큰은 초대 **생성 응답에만** 있다. |
| 예외 큐 | `EXCESS_RECEIPT`·`UNCONFIRMED_PAYMENT`·`REFUND_REQUIRED`·`FAILED_NOTIFICATION`·`PO_CANCELLATION_UNANSWERED` | 읽기 전용. **임의 종결 버튼 금지**(DEC-16 미승인). 장기 미수령은 별도 목록. |
| 취소 물량 | 처분 대기·재고 편입·반품 보관·반품 출고·반품 완료 수량 | 다섯 수량의 합이 취소 수량과 같다. |

---

## 6. 엔드포인트 목록 (명세에서 생성 — 103개)

권한 열: **Owner만** = 직원은 403 / Owner·위임 직원 = 점주가 위임을 준 직원만 / Owner·직원 = 활성 멤버 / "일부 동작은 Owner" = 예) 취소·환급 요청 승인·거절·폐기 처분은 Owner, 철회·그 외는 직원도 가능. 같은 경로라도 **본문 값에 따라** 갈리는 규칙이 있으니(재배분은 다른 고객 주문으로 옮길 때 Owner) 403은 항상 처리한다.

#### orders (7)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| GET | `…/orders` | listOrders | Owner·직원 | 200 |
| POST | `…/orders` | createOrder | Owner·직원 | 201 |
| GET | `…/orders/{orderId}` | getOrder | Owner·직원 | 200 |
| POST | `…/orders/{orderId}/confirm` | confirmOrder | Owner·직원 | 200 |
| POST | `…/orders/{orderId}/hold` | holdOrder | Owner·직원 | 200 |
| POST | `…/orders/{orderId}/resume` | resumeOrder | Owner·직원 | 200 |
| POST | `…/orders/{orderId}/discard` | discardOrder | Owner·직원 | 200 |

#### stock (4)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/orders/{orderId}/lines/{lineId}/stock-reservations` | reserveStock | Owner·직원 | 201 |
| POST | `…/books/{bookId}/initial-stock` | registerInitialStock | **Owner만** | 201 |
| POST | `…/books/{bookId}/stock-adjustments` | adjustStock | Owner·위임 직원 | 201 |
| POST | `…/stock-reservations/{reservationId}/releases` | releaseStockReservation | Owner·직원 | 201 |

#### reads (27)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| GET | `…/stock` | listStockLevels | Owner·직원 | 200 |
| GET | `…/stock/{bookId}` | getStockLevel | Owner·직원 | 200 |
| GET | `…/book-search` | searchBooks | Owner·직원 | 200 |
| GET | `…/integrations/yes24` | getYes24Status | Owner·직원 | 200 |
| GET | `…/statistics/hourly` | getHourlyStatistics | Owner·직원 | 200 |
| GET | `…/supplier-overview` | listSupplierOverview | Owner·직원 | 200 |
| GET | `…/customers` | listCustomers | Owner·직원 | 200 |
| POST | `…/customers` | registerCustomer | Owner·직원 | 201 |
| GET | `…/customers/{customerId}` | getCustomer | Owner·직원 | 200 |
| POST | `…/customers/{customerId}/updates` | updateCustomer | Owner·직원 | 200 |
| POST | `…/customers/retention-applications` | applyCustomerRetention | Owner만 | 200 |
| POST | `…/customers/{customerId}/anonymization` | anonymizeCustomer | Owner만 | 200 |
| GET | `…/customers/{customerId}/changes` | listCustomerChanges | Owner·직원(직원은 전·후 값 없음) | 200 |
| GET | `…/orders/{orderId}/customer` | getOrderCustomer | Owner·직원 | 200 |
| POST | `…/orders/{orderId}/customer` | linkOrderCustomer | Owner·직원 | 201 |
| GET | `…/exceptions` | listExceptions | Owner·직원 | 200 |
| GET | `…/allocation-cancellations` | listAllocationCancellations | Owner·직원 | 200 |
| GET | `…/refund-tasks` | listRefundTasks | Owner·직원 | 200 |
| GET | `…/order-settlements` | listOrderSettlements | Owner·직원 | 200 |
| GET | `…/notification-targets` | listNotificationQueue | Owner·직원 | 200 |
| GET | `…/receipts` | listReceipts | Owner·직원 | 200 |
| GET | `…/receipts/{receiptId}` | getReceipt | Owner·직원 | 200 |
| GET | `…/orders/{orderId}/history` | getOrderHistory | Owner·직원 | 200 |
| GET | `…/orders/{orderId}/payments` | getOrderPayments | Owner·직원 | 200 |
| GET | `…/message-templates` | listMessageTemplates | Owner·직원 | 200 |
| GET | `…/orders/{orderId}/notification-targets` | listNotificationTargets | Owner·직원 | 200 |
| GET | `…/audit-log` | listAuditLog | **Owner만** | 200 |
| GET | `…/books` | listBooks | Owner·직원 | 200 |
| GET | `…/books/{bookId}` | getBook | Owner·직원 | 200 |
| GET | `…/books/{bookId}/revisions` | listBookRevisions | Owner·직원 | 200 |
| GET | `…/dashboard` | getDashboard | Owner·직원 | 200 |
| GET | `…/long-unreceived-warnings` | longUnreceivedWarnings | Owner·직원 | 200 |
| GET | `…/suppliers` | listSuppliers | Owner·직원 | 200 |
| GET | `…/suppliers/{code}` | getSupplier | Owner·직원 | 200 |
| GET | `…/purchase-orders` | listPurchaseOrders | Owner·직원 | 200 |
| GET | `…/purchase-orders/{purchaseOrderId}` | getPurchaseOrder | Owner·직원 | 200 |

#### payments (9)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/payments/{paymentId}/void` | voidPayment | Owner·직원 | 201 |
| POST | `…/payments/{paymentId}/corrections` | correctPayment | **Owner만** | 201 |
| POST | `…/orders/{orderId}/payments` | recordPayment | Owner·직원 | 201 |
| POST | `…/payments/{paymentId}/confirmation` | confirmPayment | Owner·직원 | 201 |
| POST | `…/orders/{orderId}/refund-tasks` | openRefundTask | Owner·직원 | 201 |
| POST | `…/refund-tasks/{taskId}/refund-requests` | requestRefund | Owner·직원 | 201 |
| POST | `…/refund-tasks/{taskId}/refund-attempts` | reportRefundAttempt | Owner·직원 | 201 |
| POST | `…/refund-attempts/{attemptId}/resolution` | resolveRefundAttempt | Owner·직원 | 201 |
| POST | `…/refund-requests/{requestId}/decision` | decideRefundRequest | Owner·직원(일부 동작은 Owner) | 200 |

#### fulfillments (3)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/orders/{orderId}/fulfillments` | postFulfillment | Owner·직원 | 201 |
| POST | `…/orders/{orderId}/fulfillments/{fulfillmentId}/corrections` | correctFulfillment | **Owner만** | 201 |
| POST | `…/orders/{orderId}/cancellation-requests` | requestOrderCancellation | Owner·직원 | 201 |

#### cancellations (3)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/order-cancellation-requests/{requestId}/decision` | decideOrderCancellation | Owner·직원(일부 동작은 Owner) | 200 |
| POST | `…/order-cancellation-requests/{requestId}/application` | applyOrderCancellation | **Owner만** | 201 |
| POST | `…/orders/{orderId}/closure-requests` | requestOrderClosure | Owner·직원 | 201 |

#### dispositions (8)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/allocation-cancellations/{cancellationId}/stock-intakes` | transferCancelledToStock | **Owner만** | 201 |
| POST | `…/allocation-cancellations/{cancellationId}/return-requests` | requestReturn | **Owner만** | 201 |
| POST | `…/return-requests/{requestId}/replies` | recordReturnReply | Owner·직원 | 201 |
| POST | `…/return-requests/{requestId}/dispatches` | dispatchReturn | Owner·직원 | 201 |
| POST | `…/return-requests/{requestId}/completions` | completeReturn | Owner·직원 | 201 |
| POST | `…/return-requests/{requestId}/exceptions` | reportReturnException | Owner·직원 | 201 |
| POST | `…/return-requests/{requestId}/renegotiations` | renegotiateReturn | Owner·직원 | 201 |
| POST | `…/return-exceptions/{exceptionId}/resolutions` | resolveReturnException | Owner·직원 | 201 |

#### catalog (3)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/message-templates` | publishTemplateVersion | Owner·위임 직원 | 201 |
| POST | `…/books` | registerBook | Owner·직원 | 201 |
| POST | `…/books/{bookId}/updates` | updateBook | Owner·직원 | 200 |

#### notifications (5)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/orders/{orderId}/notification-targets` | createNotificationTarget | Owner·직원 | 201 |
| POST | `…/notification-targets/{targetId}/copies` | recordNotificationCopy | Owner·직원 | 201 |
| POST | `…/notification-targets/{targetId}/attempts` | recordNotificationAttempt | Owner·직원 | 201 |
| POST | `…/notification-targets/{targetId}/renotices` | renotify | Owner·직원 | 201 |
| POST | `…/notification-attempts/{attemptId}/result` | recordNotificationResult | Owner·직원 | 201 |

#### staffAdmin (9)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| GET | `…/store` | getStore | Owner·직원 | 200 |
| POST | `…/store/settings` | updateStoreSettings | **Owner만** | 200 |
| GET | `…/members` | listMembers | **Owner만** | 200 |
| GET | `…/staff-invitations` | listInvitations | **Owner만** | 200 |
| POST | `…/staff-invitations` | inviteStaff | **Owner만** | 201 |
| POST | `…/staff-invitations/{invitationId}/revocation` | revokeInvitation | **Owner만** | 201 |
| POST | `…/members/{targetUserId}/delegations` | setDelegation | **Owner만** | 200 |
| GET | `…/delegations` | listDelegations | **Owner만** | 200 |
| POST | `…/members/{targetUserId}/status` | setMembershipStatus | **Owner만** | 200 |

#### staff (3)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| GET | `/v1/me/memberships` | listMyMemberships | 로그인한 계정 | 200 |
| POST | `/v1/stores` | openStore | 로그인한 계정 | 201 |
| POST | `/v1/invitations/accept` | acceptInvitation | 로그인한 계정 | 201 |

#### suppliers (3)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/suppliers` | registerSupplier | Owner·위임 직원 | 201 |
| POST | `…/suppliers/{code}/updates` | updateSupplier | Owner·위임 직원 | 200 |
| POST | `…/suppliers/{code}/activation` | setSupplierActive | Owner·위임 직원 | 200 |

#### procurement (11)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/orders/{orderId}/lines/{lineId}/sourcing-allocations` | allocateSourcing | Owner·직원 | 201 |
| POST | `…/orders/{orderId}/lines/{lineId}/duplicate-risk-approvals` | approveDuplicateRisk | **Owner만** | 201 |
| POST | `…/sourcing-allocations/{allocationId}/releases` | releaseSourcing | Owner·직원 | 201 |
| POST | `…/purchase-orders` | createPurchaseOrder | Owner·직원 | 201 |
| POST | `…/purchase-orders/{purchaseOrderId}/ready` | markPurchaseOrderReady | Owner·직원 | 200 |
| POST | `…/purchase-orders/{purchaseOrderId}/delivery` | recordPurchaseOrderDelivery | Owner·직원 | 200 |
| POST | `…/purchase-orders/{purchaseOrderId}/cancellation` | cancelUndeliveredPurchaseOrder | Owner·직원 | 200 |
| POST | `…/purchase-orders/{purchaseOrderId}/lines/{poLineId}/cancellation-requests` | createCancellationRequest | Owner·직원 | 201 |
| POST | `…/purchase-orders/{purchaseOrderId}/cancellation-requests/{requestId}/responses` | respondToCancellationRequest | Owner·직원 | 201 |
| POST | `…/purchase-orders/{purchaseOrderId}/cancellation-confirmation` | confirmPurchaseOrderCancellation | Owner·직원 | 200 |
| POST | `…/purchase-orders/{purchaseOrderId}/supplier-replies` | recordSupplierReply | Owner·직원 | 201 |

#### receiving (8)

| 메서드 | 경로(`/v1/tenants/{tenantId}` 접두 생략: …) | operationId | 권한 | 성공 |
|---|---|---|---|---|
| POST | `…/purchase-orders/{purchaseOrderId}/receipts` | receiveGoods | Owner·직원 | 201 |
| POST | `…/receipts/{receiptId}/defect-resolutions` | resolveReceiptDefect | Owner·직원(일부 동작은 Owner) | 201 |
| POST | `…/receipts/{receiptId}/excess-decisions` | decideExcessReceipt | **Owner만** | 201 |
| POST | `…/receipts/{receiptId}/corrections` | correctReceipt | **Owner만** | 201 |
| POST | `…/receipts/{receiptId}/allocations` | allocateReceipt | Owner·직원 | 201 |
| POST | `…/allocations/{allocationId}/cancellations` | cancelAllocation | **Owner만** | 201 |
| POST | `…/allocations/{allocationId}/reallocations` | reallocateAllocation | Owner·직원 | 201 |
| POST | `…/allocations/{allocationId}/releases` | releaseAllocation | Owner·직원 | 201 |

경로의 `…`는 `/v1/tenants/{tenantId}`를 줄인 것이다. 요청·응답 필드의 정확한 스키마는 `openapi/ordering-http.yaml`(및 주문 4개는 `openapi/ordering.yaml`)을 보라. 두 파일 사이를 `ordering.yaml#/…`로 참조하므로 타입 생성 도구를 쓰려면 번들(병합)한 뒤 쓴다.

---

## 7. 호출 레시피 (정상 흐름의 순서)

필드 이름은 시험에서 실제로 통과한 요청에서 가져왔다. 선택 필드·열거값은 명세를 확인한다. 모든 POST에 `Idempotency-Key`가 필요하다.

**A. 시작·서점 선택** — `GET /v1/me/memberships` → (없으면) `POST /v1/stores {"storeName":"…"}`(이메일 claim 필요, 같은 소유자의 같은 이름 거부) 또는 `POST /v1/invitations/accept {"token":"…"}`.

**B. 도서 → 주문 접수·확정**
0. **YES24 검색(B-01):** `GET …/book-search?type=ISBN|TITLE|AUTHOR&q=…&limit=10` → `{ source:"YES24", fetchedAt, items:[{id,title,authors,isbn?,listPriceKrw?,…,existingBookId?}] }`. `existingBookId`가 있으면 "이미 등록된 도서" 경고를 보이고 새로 등록하지 않는다. 결과를 선택하면 `POST …/books {"source":"YES24","title":…,"authors":…,"isbn":…,"externalId":<결과 id>,"fetchedAt":<응답 fetchedAt>,"listPriceKrw":<직원이 입력한 판매가>,"registeredAt":…}`로 등록한다(외부 정가 `listPriceKrw`는 참고값). **503이면 검색 대신 아래 수기 등록으로 전환**하고 사유를 표시한다.
1. `POST …/books {"source":"MANUAL","title":"…","listPriceKrw":"16800","reason":"수기 등록","registeredAt":"…"}` → 도서 ID. (검색: `GET …/books?isbn=`·목록 커서). 수기 등록의 `source`는 `MANUAL`이다
2. `POST …/orders {"lines":[{"bookId":"…","quantity":2,"unitPriceKrw":"15000"}]}` → 초안(`version` 1). **표시번호는 확정 때 서버가 발급**한다(브라우저에서 만들지 않는다).
3. (선택) 보류 `POST …/orders/{id}/hold {"expectedVersion":1,"reason":"…","heldAt":"…"}` → 재개 `/resume {"expectedVersion":2,"resumedAt":"…"}` / 폐기 `/discard {"expectedVersion":…,"reason":"…","discardedAt":"…"}`(확정 전 초안만, 되돌릴 수 없음). 보류 중에는 확정할 수 없다(422).
4. 확정 `POST …/orders/{id}/confirm {"expectedVersion":1}` → `displayNumber`·`totalKrw` 발급.
5. 목록: `GET …/orders?limit=20&status=CONFIRMED&search=시집` — `search`는 표시번호(정확)·도서명(부분)·ISBN(정확).

**C. 조달 → 발주 → 입고 → 배분**
1. 재고로 충족: `POST …/orders/{id}/lines/{lineId}/stock-reservations {"quantity":3,"reservedAt":"…"}`. 발주로 충족: `POST …/orders/{id}/lines/{lineId}/sourcing-allocations {"supplierCode":"…","quantity":2}`.
2. `POST …/purchase-orders {"supplierCode":"…","allocationIds":["…"]}` → `/ready {"expectedVersion":1}` → `/delivery {"expectedVersion":2,"method":"EMAIL","deliveredAt":"…"}`(출력과 실제 전달은 다르다) → 공급처 회신 `/supplier-replies`.
3. 입고 `POST …/purchase-orders/{id}/receipts {"poLineId":"…","normalQuantity":5,"damagedQuantity":0,"misdeliveredQuantity":0,"receivedAt":"…"}` → 고객별 배분 `POST …/receipts/{id}/allocations {"orderId":"…","orderLineId":"…","quantity":3,"allocatedAt":"…"}`. 현황: `GET …/receipts?unallocated=true`, 상세 `GET …/receipts/{id}`(배분·해제·정정·불량·초과 이력).

**D. 안내 → 수령 → 결제**
1. 안내 대상 `POST …/orders/{id}/notification-targets {"mode":"FULL","createdAt":"…"}` → 복사·공유 기록 `/notification-targets/{id}/copies {"action":"COPY","actedAt":"…"}`(**발송이 아니다**) → 발송 시도 `/attempts {"channel":"SMS","messageSnapshot":"…","attemptedAt":"…"}` → 결과 `/notification-attempts/{id}/result {"outcome":"MANUAL_RECORDED","note":"…","resultAt":"…"}`. 서점 전체 대기 큐: `GET …/notification-targets?status=PENDING`.
2. 결제 `POST …/orders/{id}/payments {"method":"BANK_TRANSFER","amountKrw":"20000","externalReference":"…","paidAt":"…"}` → 확인 `POST …/payments/{id}/confirmation {"evidence":"…","confirmedAt":"…"}`. **확인된 결제가 수령 금액을 덮어야 수령할 수 있다**(422).
3. 수령 `POST …/orders/{id}/fulfillments {"orderLineId":"…","sources":[{"kind":"STOCK_RESERVATION","sourceId":"…","quantity":2}],"receivedAt":"…"}`. 현황: `GET …/order-settlements?unpaid=true&undelivered=true`.

**E. 취소·반품·환급** — 취소 요청 `POST …/orders/{id}/cancellation-requests` → (Owner) 결정 `/order-cancellation-requests/{id}/decision` → 적용 `/application`(취소 물량이 처분 대기가 된다) → Owner가 재고 편입 `/allocation-cancellations/{id}/stock-intakes` 또는 반품 `/return-requests`(회신·출고·완료·예외). 환급은 `POST …/orders/{id}/refund-tasks`(Owner) → 요청·시도·결정. 목록: `GET …/allocation-cancellations?open=true`, `GET …/refund-tasks?open=true`.

**F. 직원·설정(Owner)** — 초대 `POST …/staff-invitations {"email":"…","expiresAt":"…"}`(**응답의 `token`은 이때만** 한 번 보인다, 목록에는 없다) → 직원 목록 `GET …/members`·초대 목록 → 비활성화 `POST …/members/{id}/status {"status":"INACTIVE"}` → 위임 `POST …/members/{id}/delegations {"kind":"MANAGEMENT|STOCK_ADJUSTMENT","delegated":true}` → 서점 설정 `POST …/store/settings {"name":"…","longUnreceivedWarningDays":7}`.

**G. 대시보드(O-01)** — `GET …/dashboard[?since=<UTC 시각>&thresholdDays=&delayDays=]`: 주문·발주·환급·안내·미결제·미배분 입고·부분입고 잔량·**발주 지연**(전달 후 `delayDays`일, 기본 7)·취소 후속·장기 미수령 **건수**(숫자 카드). 카드를 누르면 해당 목록(§6)으로 이동한다. "오늘 접수 주문"은 서점 시간대를 아는 UI가 정한 자정을 `since`로 보낸다. 공급처별 현황은 `GET …/supplier-overview[?delayDays=]`, 예외 큐는 `GET …/exceptions`, 장기 미수령 목록은 `GET …/long-unreceived-warnings`(경고일은 서점 설정이 기본값).

---

## 8. 성능·사용성 메모
- 목록은 **서버 커서 페이지네이션**이다. "전체 개수"는 제공하지 않는다(대시보드 카드의 건수는 별개). 무한 스크롤 또는 "더 보기"로 구현한다.
- 서버는 쿼리 하나에 10초 시간 제한이 있다(초과 시 500). 같은 키로 재시도하면 안전하다.
- 쓰기 버튼은 **요청 중 비활성화**(중복 클릭 방지)하고, 같은 의도의 재시도에는 같은 `Idempotency-Key`를 쓴다.
- 쓰기 뒤에는 관련 목록·상세·대시보드를 다시 조회한다(서버가 상태·합계·표시번호를 계산한다).

## 9. 시험해 보는 법
- **계약:** `openapi/*.yaml`이 서버 경로표·본문 필드·열거값·오류 상태와 일치함을 `tests/openapi`가 매 실행 검증한다. 새 API가 생기면 명세와 이 문서의 §6 표가 함께 바뀌어야 한다.
- **응답 모양:** `tests/openapi/responseContract.test.ts`가 실제 응답이 선언한 스키마를 만족함을 확인한다(알 수 없는 필드가 새면 실패).
- **권한:** `tests/openapi/roleContractDb.test.ts`가 역할별 403을 모든 경로에서 확인한다. UI의 역할별 화면은 이 표와 §6의 권한 열을 따른다.
- **데모 모드:** 서버가 없는 화면(§10)은 `DEMO MODE` 배지를 붙이고 샘플 데이터를 실제 데이터와 섞지 않는다. 데모 조작을 실거래 성공으로 표현하지 않는다.

## 10. 서버 없음·정책 미승인 — 데모/비활성으로 둔다

| 기능 | 상태 |
|---|---|
| 고객 등록·검색·이력(C-01~04) | 서버 모듈 없음(개인정보 정책 DEC-12 결정 대기 — `release/customer_module_decisions.md`). 주문은 고객 없이 만든다. |
| YES24 도서 검색(B-01) | 서버 연동은 있다(`GET …/book-search`, `GET …/integrations/yes24`). **실제 YES24 API는 아직 확인되지 않았다**(서버 설정 `YES24_*`가 없으면 항상 503). 503이면 "미검색·장애" 사유를 표시하고 **수기 등록으로 전환**한다. 다른 외부 도서 API로 자동 전환하지 않는다. |
| 내보내기 요청·결과(S-09) | 서버 없음. |
| 확정 후 가격/품목 변경(ST-O04, DEC-08) | **정책 미승인 — 서버가 막는다**(경로 없음, DB 거부). "승인 필요"로 비활성 표시. |
| 예외 임의 종결(DEC-16)·타 고객 재배분 세부(DEC-15)·개인정보 보존(DEC-12)·고객 동의(DEC-01) | 미승인 — 활성화하지 않는다. |
| 직원 역할 변경(직원→Owner) | **하지 않기로 결정**(Owner는 서점 개설자뿐, 직원은 위임으로만 권한을 받는다). 화면에 만들지 않는다. |
| 서점 중지·해지·소유자 이전 | 서버 명령 없음. |
| 기간별 통계 카드 | 서버 없음 → 데모 값. (공급처별 현황은 `GET …/supplier-overview`로 있다.) (발주 지연 카드는 `procurement.delayedLines`로 있으나 **전달 후 경과일 기준**이다 — 공급처 회신 ETA는 반영하지 않는다.) |
| 고객 공개 주문(P1)·택배(D23)·PG/VAN(P2)·모바일 M1~M3 | 범위 밖. |
| 로그인·회원가입·비밀번호·이메일 인증 | Supabase Auth가 담당(이 서버 API 없음). |

## 11. 알려진 한계 (UI가 알아야 할 것)
- 직원은 **이름·이메일이 없고 사용자 ID**로만 식별된다(이름·이메일은 인증 제공자에만 있다). `…/members`는 `userId`·역할·활성·합류일을 준다. 초대 목록의 이메일로 이어 볼 수 있다.
- 오류 `message`는 영어 개발자용이다. 화면 문구는 `code`와 화면 맥락으로 만든다.
- 보류 사유는 이력(`…/orders/{id}/history`)에서 읽는다. 재개 뒤에도 남는다.
- 서점 이름 변경에는 낙관적 잠금이 없다(두 Owner가 동시에 바꾸면 나중 것이 이긴다).
- 결과 형태가 바뀐 서버 배포 직후, 배포 전에 처리된 요청을 **같은 키로 다시 보내면 한 번 더 실행될 수 있다**(옛 멱등 기록은 삭제하는 정책). 배포 직후 오래된 재시도 큐를 비우는 것이 안전하다.
- 쿼리 시간 초과는 500이다(재시도 가능 여부를 구분하는 별도 코드가 없다).
- 실제 Supabase 환경·실제 토큰으로는 검증하지 않았다. 연동 시 `SUPABASE_JWT_KEYS`/`SUPABASE_JWT_SECRET`·`SUPABASE_JWT_ISSUER` 설정과 토큰의 `aud`·`email` claim을 먼저 확인한다.

## 12. 관련 문서
`release/ui_scope.md`(UI 범위 결정서) · `openapi/ordering.yaml`·`openapi/ordering-http.yaml`(계약) · `release/new_project_runbook.md`(서버 실행·환경 변수) · `testing/acceptance_report.md`(검증 근거, §93~§109) · `release/go_no_go.md`(릴리스 결정).
