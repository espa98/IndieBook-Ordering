-- 001 기반: 테넌트·멤버십·RLS 헬퍼
-- 전제: Supabase 환경(anon/authenticated/service_role 역할, auth.uid()). 격리 테스트 DB에는 db/test-support의 shim을 먼저 적용한다.
-- 규칙(RLS V2.2): 업무 테이블은 tenant_id를 갖고, 직접 DML은 클라이언트 역할에 주지 않으며(쓰기는 서버 경로),
-- 조회는 GRANT와 RLS 정책을 모두 충족해야 한다. 신규 테이블은 기본 접근 거부다.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- 서점(테넌트). 중지·해지(ST-A06/A07)는 정책 승인 전이라 ACTIVE만 허용한다.
create table public.ordering_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  status text not null default 'ACTIVE' check (status in ('ACTIVE')),
  -- auth.users(id)를 가리키지만 격리 DB에는 auth.users가 없어 FK를 두지 않는다
  owner_user_id uuid not null,
  created_at timestamptz not null default now()
);

-- 구성원. 역할·활성 여부의 유일한 근거다(JWT의 역할 클레임은 신뢰하지 않는다, RLS-07).
create table public.ordering_members (
  tenant_id uuid not null references public.ordering_tenants (id),
  user_id uuid not null,
  role text not null check (role in ('OWNER', 'STAFF')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index ordering_members_user_idx on public.ordering_members (user_id) where active;

-- 마지막 활성 Owner는 비활성화·강등·삭제할 수 없다 (BR-T06). 같은 서점의 활성 Owner 행을 잠가
-- 두 세션이 동시에 서로 다른 Owner를 내리는 경쟁에서도 한쪽만 통과한다.
create function private.protect_last_owner() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  others int;
begin
  if tg_op = 'UPDATE' and not (old.role = 'OWNER' and old.active and (not new.active or new.role <> 'OWNER')) then
    return new;
  end if;
  if tg_op = 'DELETE' and not (old.role = 'OWNER' and old.active) then
    return old;
  end if;
  perform 1 from public.ordering_members
   where tenant_id = old.tenant_id and role = 'OWNER' and active
   order by user_id
     for update;
  select count(*) into others from public.ordering_members
   where tenant_id = old.tenant_id and role = 'OWNER' and active and user_id <> old.user_id;
  if others = 0 then
    raise exception 'the last active owner of a tenant cannot be deactivated, demoted or removed'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger ordering_members_protect_last_owner
  before update or delete on public.ordering_members
  for each row execute function private.protect_last_owner();

-- 멤버십 헬퍼 (RLS V2.2 §4). RLS를 우회해 멤버십을 읽으므로 SECURITY DEFINER + 고정 search_path,
-- 비로그인(auth.uid() null)이면 false, anon에는 실행 권한이 없다.
create function private.is_ordering_member(p_tenant uuid, p_roles text[]) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.ordering_members m
     where m.tenant_id = p_tenant
       and m.user_id = (select auth.uid())
       and m.active
       and m.role = any (p_roles)
  )
$$;
revoke all on function private.is_ordering_member(uuid, text[]) from public, anon;
grant execute on function private.is_ordering_member(uuid, text[]) to authenticated;

-- 권한: 클라이언트 역할에는 SELECT만(정책으로 좁힘). 쓰기는 service_role(서버 경로)만.
alter table public.ordering_tenants enable row level security;
alter table public.ordering_members enable row level security;
revoke all on public.ordering_tenants, public.ordering_members from public, anon, authenticated;
grant select on public.ordering_tenants, public.ordering_members to authenticated;
grant select, insert, update, delete on public.ordering_tenants, public.ordering_members to service_role;

create policy ordering_tenants_select on public.ordering_tenants
  for select to authenticated
  using (private.is_ordering_member(id, array['OWNER', 'STAFF']));

-- Owner는 서점 구성원 전체, Staff는 본인의 활성 행만 본다.
create policy ordering_members_select on public.ordering_members
  for select to authenticated
  using (
    private.is_ordering_member(tenant_id, array['OWNER'])
    or (user_id = (select auth.uid()) and active)
  );
