# BookFlow Ordering RLS 정책 설계 V2.2 — 비판적 개정본

**상태: 설계 개정 / DB 미적용 / 운영 배포 보류.** 기존 `RLS_정책설계_V2.1.md` 원문을 검토한 개정안이다.

## 1. V2.1 비판적 검토

|ID|심각도|발견 사항|수정|
|---|---|---|---|
|RLS-01|치명|기존 정책에 새 SELECT 정책을 추가하면 PostgreSQL PERMISSIVE 정책들이 OR 결합되어 예상 밖 조회 확대 가능|기존 정책/GRANT/뷰/함수 실행권한 전수 확인 후 **교체 계획** 수립; 정책만 추가하지 않음|
|RLS-02|치명|membership 조회가 자기 RLS에 막히거나 재귀될 수 있음|비노출 스키마의 최소 권한 membership 헬퍼 설계; 소유자·RLS bypass·검색 경로·EXECUTE 검증|
|RLS-03|높음|Owner/Staff가 같은 SELECT로 고객 개인정보·증빙을 전부 볼 위험|민감 테이블 직접 SELECT 회수, 최소 필드의 security_invoker 뷰/전용 조회 RPC로 분리|
|RLS-04|높음|서점별 FK 규칙이 개념 수준|`(tenant_id,parent_id)` 복합 FK와 부모 `UNIQUE(tenant_id,id)` 확인; UUID 단독 FK 금지|
|RLS-05|높음|`SECURITY DEFINER`를 통한 RLS 우회|비노출 schema, 고정 search_path, auth.uid()·membership·대상 tenant 재확인, 최소 EXECUTE, 감사|
|RLS-06|높음|직접 DML 차단만으로 RPC 통한 변조 방어 불충분|업무별 명령 allowlist, 권한+상태+불변식 검증, 원장 append-only 트리거|
|RLS-07|높음|JWT 역할 변경 및 직원 비활성화 시 기존 토큰 사용|JWT role claim 신뢰하지 않고 DB membership 최신 상태 확인; 민감 동작은 session revocation 정책 추가 검토|
|RLS-08|중간|`ordering_books` 공통 도서 마스터의 공개 범위 불명확|별도 읽기 전용 카탈로그 API; 내부 서지 수정은 서버 동기화만|
|RLS-09|중간|`ordering_outbox`, commands, audit 직접 조회·수정 위험|클라이언트 GRANT 없음; 내부 작업자만 최소 접근, 별도 감사 요약 API|
|RLS-10|높음|기존 expand SQL의 SELECT policy가 실제 조회 가능하다고 오해|`GRANT SELECT`와 RLS 모두 충족해야 조회 가능; 신규 테이블은 기본 접근 거부 유지|

## 2. 권한 매트릭스 (서점 소속 필수)

|자원|Owner|Staff|다른 tenant/anon|쓰기 경로|
|---|---|---|---|---|
|주문/품목/발주/입고/배분|업무 조회|업무 조회|거부|전용 명령 RPC|
|고객 개인정보|업무상 최소 필드|업무상 최소 필드|거부|서버 조회/명령 RPC|
|결제 시도/증빙|상태 요약, 제한된 증빙|필요한 상태 요약|거부|검증 명령 RPC|
|결제/환급 원장|감사 가능한 요약|최소 업무 요약|거부|서버 원장 RPC|
|승인 요청|서점 내 관리|본인 요청/허용된 업무|거부|요청/Owner 결정 RPC|
|감사 원장·commands·outbox|필터된 감사 조회|기본 거부|거부|내부 전용|
|membership|서점 구성원 관리|본인 역할만|거부|Owner 관리 RPC|
|공통 도서 마스터|허용된 카탈로그 조회|허용된 카탈로그 조회|정책에 따라|서버 동기화|

## 3. 구현 패턴: 기본 차단 + 명시적 조회

```sql
-- 격리 DB의 새 테이블에서만 사용. 기존 테이블에는 직접 적용하지 말 것.
ALTER TABLE public.ordering_payment_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ordering_payment_evidence FROM PUBLIC, anon, authenticated;
-- 직접 조회 정책을 생성하지 않는다. 최소 필드 조회 RPC만 허용한다.
```

민감하지 않은 주문 요약을 직접 조회할 경우에는 `GRANT SELECT`와 `FOR SELECT TO authenticated USING (...)`를 모두 구성해야 한다. **단, 같은 테이블의 기존 permissive 정책을 먼저 점검**하고, 안전한 단일 정책 집합으로 교체한다. `USING`은 tenant membership을 확인하고, UPDATE를 열어야 할 특수 경우에는 `USING`과 `WITH CHECK` 모두 사용한다. 본 시스템의 업무 테이블에는 일반 사용자 직접 UPDATE를 권장하지 않는다.

## 4. membership 헬퍼 계약 (설계 예시, 실행용 DDL 아님)

```sql
-- private.is_ordering_member(p_tenant uuid, p_roles text[]) RETURNS boolean
-- SECURITY DEFINER
-- SET search_path = ''
-- SELECT EXISTS (
--   SELECT 1 FROM public.ordering_members m
--   WHERE m.tenant_id = p_tenant
--     AND m.user_id = (SELECT auth.uid())
--     AND m.active = true
--     AND m.role = ANY(p_roles)
-- );
-- REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;
-- GRANT EXECUTE ON FUNCTION ... TO authenticated; -- 필요 시에만
```

**배포 전 필수 확인:** (a) 함수 소유자 최소 권한 (b) RLS 재귀 없음 (c) 비인증 auth.uid() null이면 false (d) role 파라미터가 호출자에게 권한을 확대하지 않음 (e) 함수가 `public`에 노출되지 않음 (f) `search_path` 고정 (g) 정책 내부 함수 호출 성능 (h) `FORCE ROW LEVEL SECURITY`/테이블 소유자 우회 조건. 헬퍼가 자체 RLS를 우회하는 경우 membership 조회만 수행하도록 구현한다.

## 5. 테넌트 간 FK 및 권한 확인

- 모든 서점별 업무 자식 테이블은 `tenant_id NOT NULL`; 부모 참조는 `FOREIGN KEY(tenant_id,parent_id) REFERENCES parent(tenant_id,id)`.
- FK는 관계 일관성만 보장한다. **명령 RPC는 `auth.uid()`와 대상 테넌트 및 업무별 권한을 별도로 확인**한다.
- `SECURITY DEFINER` RPC의 인자로 전달한 `tenant_id`, `approved_by`, `verified_by`, `actor_user_id`를 신뢰하지 않는다. actor는 서버에서 계산한다.
- `ordering_members`는 활성 사용자 검증에 사용하지만 일반 Staff가 다른 구성원 정보를 열람하지 못하도록 별도 정책을 둔다.
- 비로그인, 비활성 회원, 타 서점 자원, 교차 서점 연결, UUID 추측, role 변경 직후 오래된 JWT를 부정 테스트한다.

## 6. 검증 시나리오와 완료 기준

|시나리오|예상 결과|
|---|---|
|anon 주문/결제/증빙 조회 및 RPC|전부 거부|
|Staff가 다른 서점 주문 UUID 지정|404 또는 거부, 정보 노출 없음|
|Staff가 Owner 승인 결정·환급 완료·재고 조정 실행|거부|
|Staff가 외부 결제 사실 기록·종결 요청|업무 조건 충족 시 허용; 직접 무검증 완료는 거부|
|같은 키/다른 payload|409; 원장 중복 없음|
|실제 독립 세션 동일 환급 승인 동시 실행|한 번만 승인/기록|
|동일 마지막 1권에 대한 동시 고객 배분|총 배분 1권 이하|
|기존 RLS 정책과 신규 정책 OR 결합|허용 범위 확대 0건|
|함수 EXECUTE 권한 검사|anon/불필요한 authenticated 호출 불가|
|서점별 복합 FK 위반|DB 오류로 거부|

## 7. 적용 순서

1. 기존 `pg_policies`, `pg_class.relrowsecurity`, `information_schema.role_table_grants`, `pg_proc.prosecdef`, `has_function_privilege`, 뷰의 security_invoker 여부, 모든 `(tenant_id,id)` UNIQUE 및 FK를 **읽기 전용으로 수집**.
2. 독립된 격리 DB에 복제 후 현재 권한을 재현. V2.1 expand 신규 테이블에 기존 SELECT 정책이 있어도 GRANT 없으면 조회 불가함을 확인.
3. helper를 격리 환경에서 검증하고 정책 교체; 새 정책 추가로 인한 OR 확대가 없도록 회귀 검사.
4. 최소 조회 API 및 명령 RPC 구현. 감사/결제/증빙의 클라이언트 직접 GRANT 금지.
5. 실제 Owner·Staff JWT와 2개 독립 연결 동시성 테스트 및 기존 19개 테스트 재실행.
6. 보안 점검 결과와 마이그레이션/롤백 계획 승인 전 운영 배포 금지.

## 8. 미결정 및 구현 의존성

- V2.1 물리 DB expand SQL에는 일부 API 계약을 충족할 `version`, `attempt_id`, 발주 헤더 연결, 완전한 상태 전이/수량 상한 트리거가 아직 없다. RLS 문서가 이 공백을 해결했다고 주장하지 않는다.
- 민감정보 보존/삭제, Staff의 증빙 검증 책임, 결제 수동확인 후 원장 반영 조건, 미승인 예외 waiver 등은 운영 정책 확인 필요.
- 실제 DB 정책 변경 및 테스트는 **수행하지 않았다**.
