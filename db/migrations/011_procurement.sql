-- 011 발주 생성·전달·회신
-- 1) 공급처(읽기·발주 생성이 쓰는 최소 스키마). 공급처 등록·수정 명령은 아직 영속화하지 않았다.
-- 2) 발주 품목·연결은 만든 뒤 바꾸지 않는다(추가 전용).
-- 3) 같은 조달 배정은 취소되지 않은 발주 하나에만 연결할 수 있다(PO-009, 중복 발주 방지). 배정 단위 락('src:')으로 동시 생성도 직렬화한다.

create table public.ordering_suppliers (
  tenant_id uuid not null references public.ordering_tenants (id),
  code text not null check (btrim(code) <> ''),
  active boolean not null default true,
  name text check (name is null or btrim(name) <> ''),
  order_channel text check (order_channel is null or order_channel in ('WEB', 'EMAIL', 'PHONE', 'MESSENGER', 'FILE', 'API')),
  version bigint not null default 1 check (version >= 1),
  primary key (tenant_id, code)
);
alter table public.ordering_suppliers enable row level security;
revoke all on public.ordering_suppliers from public, anon, authenticated;
grant select on public.ordering_suppliers to authenticated;
grant select, insert, update on public.ordering_suppliers to service_role;
create policy ordering_suppliers_select on public.ordering_suppliers for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

create trigger ordering_po_lines_append_only before update or delete on public.ordering_po_lines
  for each row execute function private.forbid_mutation();
create trigger ordering_po_links_append_only before update or delete on public.ordering_po_links
  for each row execute function private.forbid_mutation();

create function private.guard_po_link_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('src:' || new.tenant_id::text || ':' || new.allocation_id::text, 0));
  if exists (
    select 1 from public.ordering_po_links k
      join public.ordering_po_lines l on l.tenant_id = k.tenant_id and l.id = k.po_line_id
      join public.ordering_purchase_orders p on p.tenant_id = l.tenant_id and p.id = l.purchase_order_id
     where k.tenant_id = new.tenant_id and k.allocation_id = new.allocation_id and p.status <> 'CANCELLED'
  ) then
    raise exception 'the allocation is already linked to an active purchase order' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_po_links_guard_insert before insert on public.ordering_po_links
  for each row execute function private.guard_po_link_insert();

-- 4) 발주 상태 전이 방어: 허용된 전이만, version은 그대로이거나 1 증가, 공급처·소유 서점은 바꿀 수 없다.
create function private.guard_purchase_order_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.tenant_id, new.supplier_code) is distinct from (old.id, old.tenant_id, old.supplier_code) then
    raise exception 'the supplier and owner of a purchase order cannot change' using errcode = 'P0001';
  end if;
  if new.version <> old.version and new.version <> old.version + 1 then
    raise exception 'the purchase order version can only advance by one' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not (
       (old.status = 'DRAFT' and new.status in ('READY', 'CANCELLED'))
    or (old.status = 'READY' and new.status in ('SENT', 'CANCELLED'))
    or (old.status = 'SENT' and new.status in ('ACKNOWLEDGED', 'CANCELLED', 'CLOSED'))
    or (old.status = 'ACKNOWLEDGED' and new.status in ('CANCELLED', 'CLOSED'))
  ) then
    raise exception 'the purchase order status cannot change from % to %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_purchase_orders_guard_update before update on public.ordering_purchase_orders
  for each row execute function private.guard_purchase_order_update();

-- 5) 공급처 회신은 전달된 발주(SENT·ACKNOWLEDGED)에만 넣을 수 있다.
create function private.guard_po_reply_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_status text;
begin
  select status into current_status from public.ordering_purchase_orders where tenant_id = new.tenant_id and id = new.purchase_order_id;
  if current_status is null or current_status not in ('SENT', 'ACKNOWLEDGED') then
    raise exception 'a reply can only be recorded for a sent purchase order' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_po_replies_guard_insert before insert on public.ordering_po_replies
  for each row execute function private.guard_po_reply_insert();
