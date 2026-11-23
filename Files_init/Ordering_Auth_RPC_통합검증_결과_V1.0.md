# Ordering Auth·정식원장 RPC 통합검증 결과 V1.0

검증 대상: Supabase `ordering-dev` (`nywalirmzserjndlgfco`), 2026-11-22.
근거: `Ordering_OPDS_V1.1_승인정책반영본.md`, `Ordering_STBR_V1.2_OPDS_V1.1_동기화.md`.

## 실제 수행
- 신규 RPC `public.ordering_v2_command` 배포: `create`, `po`, `receipt`, `allocation`, `notice`, `payment`, `handover`, `complete`.
- 기존 `ordering_p0_command`의 인증 사용자 실행 권한은 이전 단계에서 철회된 상태.
- SQL 세션에서 `SET LOCAL ROLE authenticated`와 `request.jwt.claim.sub`를 설정해 **JWT 클레임 모의 환경**으로 실행. 실제 GoTrue 로그인 및 HTTPS REST 호출은 아님.
- 주문 ID `a223e5db-341f-409c-86be-46f311b52fcf`: 2권 × 15,000원, 발주 2, 입고 2, 배분 2, 안내 증빙, 외부결제 확인 30,000원, 인도 2, 완료. 모든 호출 성공. `DELIVERED_NET=2` 확인.
- 다른 서점 모의 사용자로 테넌트 A에 주문 생성: `TENANT_ACCESS_DENIED` 발생(의도한 차단).
- 완료된 주문에 추가 인도: `ORDER_COMPLETED` 발생(의도한 차단).
- 원장 테이블은 인증 사용자 직접 INSERT 불가, SELECT는 활성 멤버십 기반 RLS.

## 미완료 / 운영 배포 금지 사유
1. **실제 Supabase Auth 테스트 계정 2개 미생성.** 현재 연결된 Supabase 도구에는 Auth 관리자 사용자 생성/이메일 확인 API가 없으며, 실행 컨테이너는 프로젝트 호스트로 DNS/HTTPS 접근이 되지 않음. 임의로 `auth.users` 테이블에 직접 INSERT하거나 비밀번호를 생성해 저장하지 않음.
2. **실제 브라우저와 동일한 JWT 로그인 + REST API HTTP 호출 미수행.** SQL에서 클레임을 모의한 테스트만 통과.
3. `ordering_v2_command`는 개발용 단일 품목 정상 경로에 한정. 부분입고 다중 로트 배분, 공급처 발주별 입고 상한, 예약 재고 원장, 취소·환급·정정, Owner 승인, 필수 후속업무, 원장 총량 보존의 DB 제약, 서점별 표시번호, 실거래 증빙 검증, 다중 사용자 동시성 및 완전한 버전 충돌 검사는 미구현.
4. `SECURITY DEFINER` RPC가 authenticated에 노출되어 Supabase Security Advisor 경고 1건. 함수 내 `auth.uid()`/활성 테넌트 멤버 검증과 권한 제한이 있지만 전체 보안감사 미완료. 실제 운영에는 미배포.
5. 실제 사용자 생성 후 `ordering_members`의 테스트용 가상 UUID를 실제 `auth.users.id`로 매핑해야 함. 현재 가상 UUID는 Auth 계정이 아님.
6. `ordering_v2_command`는 `notice` 증빙을 수동으로 입력하며 실제 메시지를 발송하지 않음. `payment`도 외부 결제 확인을 기록할 뿐 결제를 실행하지 않음.

## 실제 Auth + REST 검증 절차
1. Supabase 대시보드 > Authentication > Users > Add user에서 **테스트용 이메일 2개**를 만들고 각각 안전한 비밀번호를 설정. 이메일 인증 정책을 확인. 실사용 고객 정보 사용 금지.
2. 발급된 두 Auth UUID를 기록하고 각 사용자를 별도 테넌트에 `ordering_members`로 등록. 개발용 가상 UUID와 혼동하지 않음.
3. 로컬 또는 Bolt.new 프런트엔드에서 `@supabase/supabase-js`의 `signInWithPassword`로 로그인하여 세션 `access_token` 획득. publishable key만 클라이언트에 사용; secret/service_role 키 절대 노출 금지.
4. `supabase.rpc('ordering_v2_command', {p_tenant, p_order, p_action, p_key, ...})` 호출. JWT Authorization 헤더는 SDK가 자동 부착. 개발자 도구 Network 탭에서 실제 HTTP 응답 확인.
5. 테넌트 A 사용자 정상 8단계, 테넌트 B 사용자 A 데이터 조회 0건 및 A RPC 접근 거절, 중복 요청/수량 초과/중복 거래/완료 후 수정 차단을 실행하고 응답 코드·감사로그·원장 합계 기록.

## 판정
**DB 기반 정상 8단계 RPC와 SQL-모의 권한 오류 검증 통과. 실제 Auth 계정 2개 생성 및 JWT/HTTPS REST 검증은 미완료. 정식 운영 적합성 미승인.**
