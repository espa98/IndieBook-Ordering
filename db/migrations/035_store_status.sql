-- 035 서점 중지·해지(ST-A06, ST-A07): Owner가 중지(SUSPENDED)·해지(TERMINATED)하면 서점은 사용할 수 없고, 플랫폼 운영자 승인으로만 다시 ACTIVE가 된다.
-- 사용할 수 없다는 것은 서버(서점 범위 요청 전부 거부)와 RLS(멤버 헬퍼가 비활성 서점을 멤버로 인정하지 않음) 양쪽에서 막는다.
alter table public.ordering_tenants drop constraint ordering_tenants_status_check;
alter table public.ordering_tenants add constraint ordering_tenants_status_check check (status in ('ACTIVE', 'SUSPENDED', 'TERMINATED'));

create or replace function private.is_ordering_member(p_tenant uuid, p_roles text[]) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.ordering_members m
      join public.ordering_tenants t on t.id = m.tenant_id
     where m.tenant_id = p_tenant
       and m.user_id = (select auth.uid())
       and m.active
       and m.role = any (p_roles)
       and t.status = 'ACTIVE'
  )
$$;

-- 상태 변경 이력(추가 전용): 누가·언제·왜 중지·해지·재사용했는지. 서점 Owner는 서점이 비활성이어도 이력을 읽을 수 있어야 하므로 멤버 헬퍼가 아니라 Owner 여부로 직접 판단한다.
create table public.ordering_tenant_status_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  kind text not null check (kind in ('DEACTIVATED', 'REACTIVATED')),
  from_status text not null check (from_status in ('ACTIVE', 'SUSPENDED', 'TERMINATED')),
  to_status text not null check (to_status in ('ACTIVE', 'SUSPENDED', 'TERMINATED')),
  reason text not null check (btrim(reason) <> ''),
  "by" text not null check (btrim("by") <> ''),
  "at" timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (from_status <> to_status)
);
create index ordering_tenant_status_changes_tenant_idx on public.ordering_tenant_status_changes (tenant_id, recorded_at);
create trigger ordering_tenant_status_changes_append_only before update or delete on public.ordering_tenant_status_changes
  for each row execute function private.forbid_mutation();

alter table public.ordering_tenant_status_changes enable row level security;
revoke all on public.ordering_tenant_status_changes from public, anon, authenticated;
grant select on public.ordering_tenant_status_changes to authenticated;
grant select, insert on public.ordering_tenant_status_changes to service_role;
create policy ordering_tenant_status_changes_select on public.ordering_tenant_status_changes
  for select to authenticated
  using (exists (select 1 from public.ordering_members m where m.tenant_id = ordering_tenant_status_changes.tenant_id and m.user_id = (select auth.uid()) and m.active and m.role = 'OWNER'));
