-- 029 위임 부여·회수(S-03): Owner가 직원에게 공급처·문구 템플릿 관리(MANAGEMENT)와 재고 조정(STOCK_ADJUSTMENT)을 주고 거둔다.
-- 현재 위임 상태는 기존 두 테이블(ordering_management_delegations, ordering_stock_delegations)이 가지고, 서버(service_role)가 행을 넣고 지운다.
-- 부여·회수의 모든 변경은 추가 전용 이력에 남는다(누가·언제·무엇). 이력은 서점 Owner만 읽는다.
create table public.ordering_delegation_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('MANAGEMENT', 'STOCK_ADJUSTMENT')),
  delegated boolean not null,
  changed_by text not null check (btrim(changed_by) <> ''),
  changed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references public.ordering_members (tenant_id, user_id)
);
create index ordering_delegation_changes_user_idx on public.ordering_delegation_changes (tenant_id, user_id, recorded_at);
create trigger ordering_delegation_changes_append_only before update or delete on public.ordering_delegation_changes
  for each row execute function private.forbid_mutation();

alter table public.ordering_delegation_changes enable row level security;
revoke all on public.ordering_delegation_changes from public, anon, authenticated;
grant select on public.ordering_delegation_changes to authenticated;
grant select, insert on public.ordering_delegation_changes to service_role;
create policy ordering_delegation_changes_select on public.ordering_delegation_changes
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER']));

-- 서버가 위임을 주고 거둔다
grant insert, delete on public.ordering_management_delegations to service_role;
grant insert, delete on public.ordering_stock_delegations to service_role;
