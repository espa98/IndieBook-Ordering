-- 012 조달 배정 해제 기록과 배정 방어
-- 배정(`ordering_sourcing_allocations`)은 004가 만들었다. 이 마이그레이션은 해제 기록(추가 전용)을 더한다.
-- 락: 배정 단위 'src:<서점>:<배정>'(발주 연결 트리거와 같은 키), 주문 품목 단위 'sline:<서점>:<품목>'.

create table public.ordering_sourcing_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  allocation_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  supplier_code text not null check (btrim(supplier_code) <> ''),
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  retained_obligations jsonb not null default '[]'::jsonb,
  released_by text not null check (btrim(released_by) <> ''),
  released_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, allocation_id) references public.ordering_sourcing_allocations (tenant_id, id)
);
create trigger ordering_sourcing_releases_append_only before update or delete on public.ordering_sourcing_releases
  for each row execute function private.forbid_mutation();
alter table public.ordering_sourcing_releases enable row level security;
revoke all on public.ordering_sourcing_releases from public, anon, authenticated;
grant select on public.ordering_sourcing_releases to authenticated;
grant select, insert on public.ordering_sourcing_releases to service_role;
create policy ordering_sourcing_releases_select on public.ordering_sourcing_releases for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

-- 배정 방어: 열린 주문에만, 활성 배정 합이 주문 품목 수량을 넘지 않게, 해제는 되돌릴 수 없고 다른 열은 바꿀 수 없다.
create trigger ordering_sourcing_allocations_guard_order_open before insert on public.ordering_sourcing_allocations
  for each row execute function private.guard_order_open_for_transactions();

create function private.guard_sourcing_allocation_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  line_quantity int;
  active_quantity bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('sline:' || new.tenant_id::text || ':' || new.order_line_id::text, 0));
  select quantity into line_quantity from public.ordering_order_lines
   where tenant_id = new.tenant_id and order_id = new.order_id and id = new.order_line_id;
  select coalesce(sum(quantity), 0) into active_quantity from public.ordering_sourcing_allocations
   where tenant_id = new.tenant_id and order_line_id = new.order_line_id and status = 'ACTIVE';
  if new.status = 'ACTIVE' and active_quantity + new.quantity > line_quantity then
    raise exception 'active sourcing quantity would exceed the order line quantity' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_sourcing_allocations_guard_insert before insert on public.ordering_sourcing_allocations
  for each row execute function private.guard_sourcing_allocation_insert();

create function private.guard_sourcing_allocation_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.tenant_id, new.order_id, new.order_line_id, new.supplier_code, new.quantity)
       is distinct from (old.id, old.tenant_id, old.order_id, old.order_line_id, old.supplier_code, old.quantity) then
    raise exception 'only the status of a sourcing allocation can change' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not (old.status = 'ACTIVE' and new.status = 'RELEASED') then
    raise exception 'a released sourcing allocation cannot be reactivated' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_sourcing_allocations_guard_update before update on public.ordering_sourcing_allocations
  for each row execute function private.guard_sourcing_allocation_update();
