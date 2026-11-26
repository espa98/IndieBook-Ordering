-- 030 서점 설정(S-01, S-07): 서점별 장기 미수령 경고일(DEC-07, 기본 7일, 자동 취소 없음)과 설정 변경 이력.
-- 서점 이름과 경고일은 Owner만 서버를 거쳐 바꾼다. 바뀐 항목의 전·후 값은 추가 전용 이력에 남고 서점 Owner만 읽는다.
alter table public.ordering_tenants
  add column long_unreceived_warning_days int not null default 7 check (long_unreceived_warning_days between 1 and 365);

create table public.ordering_tenant_setting_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  changes jsonb not null check (jsonb_typeof(changes) = 'object' and changes <> '{}'::jsonb),
  changed_by text not null check (btrim(changed_by) <> ''),
  changed_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create index ordering_tenant_setting_changes_tenant_idx on public.ordering_tenant_setting_changes (tenant_id, recorded_at);
create trigger ordering_tenant_setting_changes_append_only before update or delete on public.ordering_tenant_setting_changes
  for each row execute function private.forbid_mutation();

alter table public.ordering_tenant_setting_changes enable row level security;
revoke all on public.ordering_tenant_setting_changes from public, anon, authenticated;
grant select on public.ordering_tenant_setting_changes to authenticated;
grant select, insert on public.ordering_tenant_setting_changes to service_role;
create policy ordering_tenant_setting_changes_select on public.ordering_tenant_setting_changes
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER']));
