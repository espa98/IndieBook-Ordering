-- 격리 테스트 DB 전용. 실제 Supabase에는 아래 역할·스키마·함수가 이미 있으므로 적용하지 않는다.
-- 마이그레이션이 Supabase 환경(anon/authenticated/service_role, auth.uid())을 전제로 쓰였기 때문에
-- 같은 정책·함수를 격리 DB에서도 똑같이 실행해 보려고 최소한만 흉내 낸다.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase의 auth.uid()와 같은 정의: 요청 JWT 클레임의 sub
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
