-- 013 공급처 관리: 변경 이력(추가 전용)과 관리 위임, 공급처 갱신 방어
-- 점주가 위임한 직원만 공급처를 관리할 수 있다(STBR "O/위임 S"). 위임을 주고 거두는 명령은 아직 없어 위임 테이블은 읽기 스키마만 둔다.
-- 락: 공급처 단위 'sup:<서점>:<코드>'.

create table public.ordering_management_delegations (
  tenant_id uuid not null references public.ordering_tenants (id),
  user_id uuid not null,
  delegated_by text not null check (btrim(delegated_by) <> ''),
  delegated_at timestamptz not null,
  primary key (tenant_id, user_id)
);

create table public.ordering_supplier_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  kind text not null check (kind in ('REGISTERED', 'UPDATED', 'DEACTIVATED', 'REACTIVATED')),
  before jsonb,
  after jsonb not null,
  reason text check (reason is null or btrim(reason) <> ''),
  open_purchase_order_ids jsonb,
  "by" text not null check (btrim("by") <> ''),
  "at" timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, code) references public.ordering_suppliers (tenant_id, code)
);
create trigger ordering_supplier_changes_append_only before update or delete on public.ordering_supplier_changes
  for each row execute function private.forbid_mutation();

-- 공급처 갱신: 코드·소유 서점은 바꿀 수 없고 version은 정확히 1 증가한다.
create function private.guard_supplier_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.tenant_id, new.code) is distinct from (old.tenant_id, old.code) then
    raise exception 'the code of a supplier cannot change' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'the supplier version must advance by one' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_suppliers_guard_update before update on public.ordering_suppliers
  for each row execute function private.guard_supplier_update();

alter table public.ordering_management_delegations enable row level security;
alter table public.ordering_supplier_changes enable row level security;
revoke all on public.ordering_management_delegations, public.ordering_supplier_changes from public, anon, authenticated;
grant select on public.ordering_management_delegations, public.ordering_supplier_changes to authenticated;
grant select on public.ordering_management_delegations to service_role;
grant select, insert on public.ordering_supplier_changes to service_role;
create policy ordering_management_delegations_select on public.ordering_management_delegations for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_supplier_changes_select on public.ordering_supplier_changes for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
