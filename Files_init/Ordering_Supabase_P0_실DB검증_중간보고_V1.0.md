# Ordering Supabase P0 실DB 검증 중간보고 V1.0

작성일: 2026-11-22

## 환경
- Supabase 조직: aSoftOne
- 프로젝트: ordering-dev (`nywalirmzserjndlgfco`)
- 리전: ap-northeast-2 (서울)
- PostgreSQL: 17.12
- 생성 시 비용 견적: 월 $0 (추후 사용량·플랜 변경 비용은 별도)
- 프로젝트: https://supabase.com/dashboard/project/nywalirmzserjndlgfco

## 실제 실행 결과
1. 프로젝트 생성 및 ACTIVE_HEALTHY 확인: 통과.
2. PostgreSQL 연결 및 버전 조회: 통과.
3. Ordering 전용 5개 테이블 및 RLS 정책 생성: 마이그레이션 성공.
4. 8단계 RPC `ordering_p0_command` 생성: 마이그레이션 성공.
5. 테스트 테넌트 2개, 가상 멤버 2명 준비: 성공 (실제 Auth 사용자 생성은 아님).
6. 테스트 주문 2권, 15,000원/권 생성 → 발주 2 → 입고 2 → 배분 2 → 안내 → 외부 확인 결제 30,000원 기록 → 수령 2 → 완료: SQL 호출로 성공, 최종 `completed` 확인.
7. 다른 테넌트 사용자 역할의 RLS SELECT: 0건 확인.
8. 다른 테넌트에 대한 RPC 호출: `TENANT_ACCESS_DENIED` 오류 확인.
9. 동일 idempotency key로 주문 생성 재시도: 동일 주문 ID 반환 확인.
10. `authenticated` 직접 원장 INSERT 권한: false 확인; RPC 실행 권한: true 확인.
11. Security Advisor: `authenticated_security_definer_function_executable` 경고 1건. 공개 RPC는 인증과 활성 멤버십을 검사하지만, 운영 전 함수 보안 리뷰 및 감사 필요.

## 중요한 제한과 미완성
- 이 검증은 **실제 Supabase DB에 SQL을 실행하고 인증 역할을 모의 설정한 RPC 테스트**다. 실제 JWT 로그인·PostgREST HTTP 요청·브라우저 UI 연결·동시성 부하 시험은 실행하지 않았다.
- 이번 스키마와 RPC는 **핵심 흐름의 최소 검증용**이다. 정식 Ordering 전체 DB·RLS·API 구현으로 간주하면 안 된다.
- `notice`는 실제 발송 결과가 아닌 단순 이벤트로 처리된다. 실제 고객 안내 결과 검증 미구현.
- `payment`는 실제 외부 결제 증빙 검증이 아닌 참조번호 기록만 수행한다. 실제 입금 확인 및 결제사업자 대사 미구현.
- 공급처별 발주, 입고 검수 상세, 재고 수불원장, 취소·반품·환급, 직원 승인, 다중 도서 주문, 복수 결제 시나리오, 동시성·실패 복구는 추가 구현 필요.
- 가상 테스트 멤버는 `auth.users`에 생성되지 않았으며 테스트 SQL에서 JWT sub를 모의했다. 실제 로그인 연동 검증은 별도.
- 보안 리뷰 없이 외부 고객이 사용하는 서비스로 공개하면 안 된다. 개발 전용 프로젝트로 유지할 것.

## 다음 검증 작업
1. OPDS V1.1/STBR V1.2 기반 정식 테이블·원장·상태 전이 모델 구현.
2. 실제 Supabase Auth 테스트 사용자 생성 및 로그인, REST RPC 호출.
3. RLS 교차 테넌트·직원 승인·비인가 변경 테스트 자동화.
4. 결제·안내 외부 검증 증빙과 멱등성/동시성 테스트.
5. Supabase Security Advisor 경고 검토, 함수 최소권한 및 API 노출 점검.
