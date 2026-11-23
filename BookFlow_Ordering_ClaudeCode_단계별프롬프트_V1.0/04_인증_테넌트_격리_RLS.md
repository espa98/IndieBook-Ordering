# 04단계 — 인증·테넌트 격리·RLS

## Claude Code에 붙여넣을 프롬프트

```text
먼저 `00_공통_안전규칙.md`의 모든 지시를 적용하라.

읽기: `Docs/05_API_Security/RLS_정책설계_V2.2.md`, OPDS 권한 매트릭스, FRD AUTH, UC 인증 흐름.
요청: 현재 GRANT, permissive/restrictive RLS, SECURITY DEFINER, 함수 EXECUTE, view security_invoker를 먼저 조사하라. 신규 테이블 기본 거부, 최소 조회 경로, 원장 직접 DML 금지, 최신 활성 membership 조회를 구현하라. RLS 정책을 단순 추가하여 OR로 권한이 넓어지지 않게 하라. Staff의 Owner 전용 승인·환급·재고 조정은 차단하되 일반 주문 업무는 허용한다. JWT role claim만 믿지 마라.
테스트: anon/비활성/타 tenant/UUID 추측/role 변경/교차 FK/직접 DML/SECURITY DEFINER 실행권한. 실제 JWT 미준비면 모의 결과와 미실행을 분리.
산출물: SQL·테스트·`security/rls_review.md`. 격리 DB에서만 실행.

이번 단계 완료 후 변경 파일과 검증 결과를 제시하고, 다음 단계로 자동 진행하지 말고 사용자 확인을 기다려라.
```
