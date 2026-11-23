# 05단계 — 주문 등록·목록·상세·확정 API

## Claude Code에 붙여넣을 프롬프트

```text
먼저 `00_공통_안전규칙.md`의 모든 지시를 적용하라.

읽기: `Docs/05_API_Security/API_명세서_V2.2.md`, 구현현황표, OPDS DEC-13, STBR ST-O01~03, FRD ORD, UC 주문.
요청: POST `/v1/tenants/{tenantId}/orders`, GET `/orders`, GET `/orders/{orderId}`, POST `/orders/{orderId}/confirm`의 OpenAPI 계약, 입력검증, RPC, 테스트를 구현하라. 생성은 UUID의 DRAFT, 확정은 최소 1품목·가격 스냅샷·서점별 재사용 없는 표시번호와 version 증가를 같은 트랜잭션에서 처리. Owner/Staff 허용. 목록은 `(created_at,id)` 안정 커서, 최대 100, 최소 PII. 금액은 JSON 10진 정수 문자열, 쓰기는 멱등키, 확정은 expectedVersion 필수. 같은 키/다른 본문 409, 동시 확정 한 건만 성공. 기존 `ordering_v2_command`는 자동 대체 금지; 레거시 회귀 테스트 작성.
테스트: 다품목, 누락/초과 입력, 타 tenant, Staff, 비활성, 동일 키 재시도, 동시 확정, 감사 롤백. HTTP 라우터 미배포 시 미배포로 표기.
산출물: `openapi/ordering.yaml`, API/RPC 코드, 테스트, `implementation/05_orders_results.md`.

이번 단계 완료 후 변경 파일과 검증 결과를 제시하고, 다음 단계로 자동 진행하지 말고 사용자 확인을 기다려라.
```
