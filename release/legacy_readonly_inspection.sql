-- E5: 레거시 `ordering-dev` 읽기 전용 점검 (SELECT만 있다)
-- 실행 조건: 사용자의 별도 승인 후, 사람이 SQL 편집기 등에서 실행한다. 이 저장소의 코드·테스트는 이 파일을 DB에 실행하지 않는다.
-- 이 파일에는 변경·권한·세션 설정 문장이 없다(tests/release/legacyInspection.test.ts가 감시한다).
-- 결과에는 데이터 행이 아니라 메타데이터와 테이블별 행 수만 나온다. 결과를 release/legacy_rpc_analysis.md §7에 붙여 넣는다.

-- 1) public 스키마의 ordering 함수: 보안 정의자 여부, 소유자, 호출 권한 (has_function_privilege로 실제 권한을 본다)
select p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       pg_get_userbyid(p.proowner) as owner,
       p.proconfig as function_settings,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'ordering%'
 order by p.proname;

-- 2) 레거시 RPC의 전체 정의(분기·검사 순서·오류 코드를 문서와 대조하기 위해)
select p.proname as function_name, pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'ordering%'
 order by p.proname;

-- 3) ordering 테이블의 열(이름·타입·널 허용·기본값): 새 마이그레이션과 같은 이름의 테이블이 어떻게 다른지 본다
select c.table_name, c.ordinal_position, c.column_name, c.data_type, c.is_nullable, c.column_default
  from information_schema.columns c
 where c.table_schema = 'public' and c.table_name like 'ordering%'
 order by c.table_name, c.ordinal_position;

-- 4) 제약(기본 키·외래 키·유일·검사)
select conrelid::regclass::text as table_name, conname as constraint_name, contype as constraint_type, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where connamespace = 'public'::regnamespace and conrelid::regclass::text like 'ordering%'
 order by 1, 2;

-- 5) 트리거(내부 트리거 제외)와 그 함수
select c.relname as table_name, t.tgname as trigger_name, pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname like 'ordering%'
 order by 1, 2;

-- 6) 행 수준 보안 사용 여부와 정책
select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'ordering%'
 order by 1;

select tablename as table_name, policyname as policy_name, cmd, roles, qual as using_clause, with_check
  from pg_policies
 where schemaname = 'public' and tablename like 'ordering%'
 order by 1, 2;

-- 7) 테이블 권한(anon·authenticated·service_role이 무엇을 할 수 있는가)
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name like 'ordering%' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
 group by table_name, grantee
 order by table_name, grantee;

-- 8) private 스키마: 새 마이그레이션이 같은 이름(private.is_ordering_member, forbid_mutation, protect_last_owner 등)을 만든다
select n.nspname as schema_name, p.proname as function_name, pg_get_function_identity_arguments(p.oid) as arguments, p.prosecdef as security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'private'
 order by p.proname;

-- 9) 테이블별 행 수(개수만, 내용은 보지 않는다)와 개발용 테스트 데이터인지 가늠할 서점 수
select t.table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text::bigint as row_count
  from information_schema.tables t
 where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name like 'ordering%'
 order by t.table_name;

-- 10) 확장과 서버 버전(gen_random_uuid·pgcrypto 사용 가능 여부, 마이그레이션 호환)
select extname, extversion from pg_extension order by extname;

select version() as server_version;
