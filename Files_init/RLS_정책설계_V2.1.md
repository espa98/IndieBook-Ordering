# BookFlow Ordering RLS 정책 설계 V2.1

**설계안 / DB 미적용.** 기존 expand SQL은 16개 신규 tenant 테이블에 RLS SELECT 정책을 만들었으나 `authenticated` SELECT GRANT까지 제공하지 않아 **현재 직접 조회가 허용된 상태는 아니다**. 또한 정책의 tenant 비교는 테이블 별칭으로 명시하여 모호성을 제거해야 한다.

## 1. 원칙
1. 모든 서점별 테이블 `tenant_id NOT NULL`, 부모에 `UNIQUE(tenant_id,id)`, 자식에 `(tenant_id,parent_id)` 복합 FK.
2. `auth.uid()`와 **활성 membership**을 DB에서 매 요청 검사. 사용자 수정 가능한 JWT `user_metadata`로 권한 결정 금지.
3. 일반 클라이언트에는 테이블 직접 INSERT/UPDATE/DELETE 불허. 조회는 업무별 최소 범위. 원장/감사/승인/증빙은 특히 제한.
4. 내부 명령 함수는 가능하면 비노출 스키마에 두고 `SECURITY DEFINER` 최소화, 명시적 `search_path`, 함수 EXECUTE 최소 GRANT, 인자 tenant/row 소속 재검증. service_role은 브라우저에 배포 금지.
5. 외부 결제 증빙과 개인정보는 테이블 행 RLS 외에 컬럼 분리/전용 뷰·조회 RPC로 노출 최소화.

## 2. 권한 매트릭스
| 테이블 그룹 | Owner SELECT | Staff SELECT | anon | 직접 DML |
|---|---|---|---|---|
| tenants / members | 소속 정보·직원 목록 | 자신의 소속/역할만 | 거부 | Owner 관리 RPC |
| orders, order_lines, PO, receipts, allocations, reservations | 소속 서점 | 소속 서점 | 거부 | 전용 RPC만 |
| customers | 제한된 업무 필드 | 최소 업무 필드 | 거부 | 전용 RPC만 |
| payment_attempts / payment_evidence | 거래 조회(증빙 상세 별도) | 업무상 최소 거래 조회 | 거부 | 검증 RPC만 |
| payment_ledger / refund | 소속 서점 | 업무상 필요한 요약만 | 거부 | Owner 승인 RPC 등 |
| approval_requests | 소속 서점 | 본인 요청·업무 범위 | 거부 | 요청·결정 RPC |
| audit_ledger / commands / outbox | Owner 제한 조회 | 기본 거부 | 거부 | 서버 전용 |
| books 글로벌 | 서버 동기화/공개용 별도 API | 동일 | 정책별 | 서버 전용 |

## 3. 최소 조회 RLS 예시 (독립 격리 환경용)
다음 SQL은 `ordering_orders`의 예시다. 전체 테이블에 일괄 적용하지 말 것. 실제 조회 허용 범위를 확인한 뒤 각각 작성해야 한다.
```sql
ALTER TABLE public.ordering_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ordering_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ordering_orders TO authenticated;
CREATE POLICY ordering_orders_member_read_v21
ON public.ordering_orders FOR SELECT TO authenticated
USING (
 EXISTS (
  SELECT 1 FROM public.ordering_members AS m
  WHERE m.tenant_id = ordering_orders.tenant_id
    AND m.user_id = (SELECT auth.uid())
    AND m.active
    AND m.role IN ('owner','staff')
 )
);
```
**주의:** 위 SQL을 기존 프로젝트에 그대로 실행하면 현재 정책/GRANT를 변경할 수 있다. 실 DB의 기존 정책과의 OR 결합 및 RLS 우회 여부를 검토한 뒤 격리 DB에서만 사용한다. 회원 테이블 조회 자체에 RLS가 걸려 membership 검사가 실패하거나 순환할 수 있으므로, 회원 확인은 검증된 내부 `SECURITY DEFINER` 헬퍼(비노출 스키마)로 분리하는 방안을 우선 평가한다.

## 4. 회원 확인 헬퍼 제안 (의사 SQL, 그대로 배포 금지)
```sql
-- private schema not exposed via PostgREST
-- private.is_tenant_member(p_tenant uuid, p_roles text[]) returns boolean
-- SECURITY DEFINER, SET search_path='', explicit public.ordering_members references
-- SELECT EXISTS (SELECT 1 FROM public.ordering_members
-- WHERE tenant_id=p_tenant AND user_id=auth.uid() AND active AND role=ANY(p_roles));
-- REVOKE EXECUTE FROM PUBLIC,anon; GRANT EXECUTE TO authenticated only if necessary.
```
권한 헬퍼 소유자, search_path, FORCE RLS 여부, 실행 계획, 재귀 및 인증 없는 호출 차단을 실제 엔진에서 검증해야 한다.

## 5. 강제 부정 테스트
- anon SELECT/INSERT/RPC 전부 거부; 비활성 회원·다른 서점·임의 UUID 참조 거부.
- Staff가 Owner 승인·환급 완료·감사 원장 내보내기·직원 권한 변경 불가.
- Staff가 정상 주문/입고/외부 결제 증빙 기록/종결 요청 가능(업무 조건 충족 시).
- 동일 idempotency key 다른 payload=409; 같은 payload 동일 결과.
- 별도 JWT 2개로 동일 환급 동시 승인 시 승인 1회·환급 원장 1행; 동일 마지막 1권 동시 배분 시 총 1권 이하.
- 취소 후 공급처 미수락량이 남으면 종결 거부; 미처리 버킷/예외/미확인 결제 있으면 종결 거부.

## 6. 사전 점검 SQL
```sql
SELECT schemaname,tablename,policyname,cmd,roles,qual,with_check
FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'ordering_%';
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c WHERE c.relnamespace='public'::regnamespace
AND c.relname LIKE 'ordering_%' AND c.relkind='r';
SELECT p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth_execute
FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'ordering_%';
```
