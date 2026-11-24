-- 016 입고 후속: 파손·오배송 해소, 초과입고 결정, 입고 정정 방어
-- 입고 기록은 바꾸지 않고 처리 결과만 추가 전용으로 남긴다(BR-P06). 종결 판정이 이 기록을 읽는다.
-- 락: 정정은 발주 품목 락('pol:', 배분·입고와 같은 키), 해소·결정은 입고 단위 락('rcpt:').

create table public.ordering_receipt_defect_resolutions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  receipt_id uuid not null,
  purchase_order_id uuid not null,
  kind text not null check (kind in ('DAMAGED', 'MISDELIVERED')),
  quantity int not null check (quantity >= 1),
  outcome text not null check (outcome in ('RETURNED_TO_SUPPLIER', 'SUPPLIER_CREDIT', 'DISCARDED')),
  evidence text not null check (btrim(evidence) <> ''),
  resolved_by text not null check (btrim(resolved_by) <> ''),
  resolved_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, receipt_id) references public.ordering_goods_receipts (tenant_id, id)
);
create table public.ordering_excess_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  receipt_id uuid not null,
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  decided_by text not null check (btrim(decided_by) <> ''),
  decided_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, receipt_id) references public.ordering_goods_receipts (tenant_id, id)
);
create trigger ordering_receipt_defect_resolutions_append_only before update or delete on public.ordering_receipt_defect_resolutions
  for each row execute function private.forbid_mutation();
create trigger ordering_excess_decisions_append_only before update or delete on public.ordering_excess_decisions
  for each row execute function private.forbid_mutation();

alter table public.ordering_receipt_defect_resolutions enable row level security;
alter table public.ordering_excess_decisions enable row level security;
revoke all on public.ordering_receipt_defect_resolutions, public.ordering_excess_decisions from public, anon, authenticated;
grant select on public.ordering_receipt_defect_resolutions, public.ordering_excess_decisions to authenticated;
grant select, insert on public.ordering_receipt_defect_resolutions, public.ordering_excess_decisions to service_role;
create policy ordering_receipt_defect_resolutions_select on public.ordering_receipt_defect_resolutions for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_excess_decisions_select on public.ordering_excess_decisions for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

-- 해소는 검수에서 기록된 종류별 수량을, 결정은 초과 수량을 넘을 수 없다.
create function private.guard_receipt_followup_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  recorded int;
  done bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('rcpt:' || new.tenant_id::text || ':' || new.receipt_id::text, 0));
  if tg_table_name = 'ordering_receipt_defect_resolutions' then
    select case when new.kind = 'DAMAGED' then damaged_quantity else misdelivered_quantity end into recorded
      from public.ordering_goods_receipts where tenant_id = new.tenant_id and id = new.receipt_id;
    select coalesce(sum(quantity), 0) into done from public.ordering_receipt_defect_resolutions
     where tenant_id = new.tenant_id and receipt_id = new.receipt_id and kind = new.kind;
    if done + new.quantity > recorded then
      raise exception 'the resolved quantity exceeds the quantity recorded at inspection' using errcode = 'P0001';
    end if;
  else
    select excess_quantity into recorded from public.ordering_goods_receipts where tenant_id = new.tenant_id and id = new.receipt_id;
    select coalesce(sum(quantity), 0) into done from public.ordering_excess_decisions
     where tenant_id = new.tenant_id and receipt_id = new.receipt_id;
    if done + new.quantity > recorded then
      raise exception 'the decided quantity exceeds the excess quantity of the receipt' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger ordering_receipt_defect_resolutions_guard_insert before insert on public.ordering_receipt_defect_resolutions
  for each row execute function private.guard_receipt_followup_insert();
create trigger ordering_excess_decisions_guard_insert before insert on public.ordering_excess_decisions
  for each row execute function private.guard_receipt_followup_insert();

-- 입고 정정은 미배분 수량(정상 순량 - 배분 순량)을 넘을 수 없다. 배분 가드와 같은 발주 품목 락을 잡는다.
create function private.guard_receipt_correction_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rc record;
  corrected bigint;
  allocated bigint;
begin
  select po_line_id, normal_quantity into rc from public.ordering_goods_receipts where tenant_id = new.tenant_id and id = new.receipt_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('pol:' || new.tenant_id::text || ':' || rc.po_line_id::text, 0));
  select coalesce(sum(quantity), 0) into corrected from public.ordering_receipt_corrections where tenant_id = new.tenant_id and receipt_id = new.receipt_id;
  select coalesce(sum(a.quantity), 0) - coalesce((select sum(r.quantity) from public.ordering_allocation_releases r
                                                   join public.ordering_receipt_allocations x on x.tenant_id = r.tenant_id and x.id = r.allocation_id
                                                  where x.tenant_id = new.tenant_id and x.receipt_id = new.receipt_id), 0)
    into allocated
    from public.ordering_receipt_allocations a where a.tenant_id = new.tenant_id and a.receipt_id = new.receipt_id;
  if new.quantity > rc.normal_quantity - corrected - allocated then
    raise exception 'the corrected quantity exceeds the unallocated quantity of the receipt' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_receipt_corrections_guard_insert before insert on public.ordering_receipt_corrections
  for each row execute function private.guard_receipt_correction_insert();
