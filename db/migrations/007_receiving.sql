-- 007 발주(읽기 스키마)·검수 입고·고객별 배분
-- 발주 생성·전달·회신 명령은 아직 영속화하지 않았다. 입고가 읽는 상태(발주·품목·연결·회신·취소 응답)만 스키마로 둔다.
-- 입고·배분·해제·인도 원장은 추가 전용이다. 잔량·상태는 저장하지 않고 기록에서 파생한다(BR-Q16).
-- 락 순서: 주문 행 -> 주문 인도 락 -> 책 락 -> 발주 품목 락('pol:<서점>:<발주 품목>').
-- 트리거 함수는 호출자(service_role) 권한으로 실행되므로 private 스키마의 다른 함수를 부르지 않고 락을 직접 잡는다.

create table public.ordering_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  supplier_code text not null check (btrim(supplier_code) <> ''),
  status text not null check (status in ('DRAFT', 'READY', 'SENT', 'ACKNOWLEDGED', 'CANCELLED', 'CLOSED')),
  version bigint not null default 1 check (version >= 1),
  delivery jsonb,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.ordering_po_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  book_key text not null check (btrim(book_key) <> ''),
  quantity int not null check (quantity >= 1),
  unique (tenant_id, id),
  unique (tenant_id, purchase_order_id, id),
  foreign key (tenant_id, purchase_order_id) references public.ordering_purchase_orders (tenant_id, id)
);

-- 발주 품목과 주문 품목의 N:M 연결(PO-009). 수량은 조달 배정 수량이다.
create table public.ordering_po_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  po_line_id uuid not null,
  allocation_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity >= 1),
  foreign key (tenant_id, po_line_id) references public.ordering_po_lines (tenant_id, id),
  foreign key (tenant_id, order_id, order_line_id) references public.ordering_order_lines (tenant_id, order_id, id)
);
create index ordering_po_links_line_idx on public.ordering_po_links (tenant_id, po_line_id);

create table public.ordering_po_replies (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  po_line_id uuid not null,
  kind text not null check (kind in ('CONFIRM', 'OUT_OF_STOCK', 'DELAY')),
  quantity int not null check (quantity >= 1),
  source text check (source is null or source in ('UNANSWERED', 'DELAYED')),
  eta date,
  evidence text not null check (btrim(evidence) <> ''),
  replied_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, purchase_order_id, po_line_id) references public.ordering_po_lines (tenant_id, purchase_order_id, id)
);

create table public.ordering_po_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  po_line_id uuid not null,
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  requested_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, purchase_order_id, po_line_id) references public.ordering_po_lines (tenant_id, purchase_order_id, id)
);
create table public.ordering_po_cancellation_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  po_line_id uuid not null,
  request_id uuid not null,
  accepted_quantity int not null check (accepted_quantity >= 0),
  rejected_quantity int not null check (rejected_quantity >= 0),
  evidence text not null check (btrim(evidence) <> ''),
  replied_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, request_id) references public.ordering_po_cancellation_requests (tenant_id, id),
  foreign key (tenant_id, purchase_order_id, po_line_id) references public.ordering_po_lines (tenant_id, purchase_order_id, id)
);

-- 검수 입고. 정상량만 배분할 수 있고, 초과·파손·오배송은 별도 수량이다.
create table public.ordering_goods_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  po_line_id uuid not null,
  normal_quantity int not null check (normal_quantity >= 0),
  excess_quantity int not null default 0 check (excess_quantity >= 0),
  damaged_quantity int not null default 0 check (damaged_quantity >= 0),
  misdelivered_quantity int not null default 0 check (misdelivered_quantity >= 0),
  inspected_by text not null check (btrim(inspected_by) <> ''),
  received_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (normal_quantity + excess_quantity + damaged_quantity + misdelivered_quantity > 0),
  foreign key (tenant_id, purchase_order_id, po_line_id) references public.ordering_po_lines (tenant_id, purchase_order_id, id)
);
create index ordering_goods_receipts_line_idx on public.ordering_goods_receipts (tenant_id, po_line_id);

create table public.ordering_receipt_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  receipt_id uuid not null,
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  corrected_by text not null check (btrim(corrected_by) <> ''),
  corrected_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, receipt_id) references public.ordering_goods_receipts (tenant_id, id)
);

create table public.ordering_receipt_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  receipt_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity >= 1),
  allocated_by text not null check (btrim(allocated_by) <> ''),
  allocated_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, receipt_id) references public.ordering_goods_receipts (tenant_id, id),
  foreign key (tenant_id, order_id, order_line_id) references public.ordering_order_lines (tenant_id, order_id, id)
);
create index ordering_receipt_allocations_receipt_idx on public.ordering_receipt_allocations (tenant_id, receipt_id);

create table public.ordering_allocation_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  allocation_id uuid not null,
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  released_by text not null check (btrim(released_by) <> ''),
  released_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, allocation_id) references public.ordering_receipt_allocations (tenant_id, id)
);
create table public.ordering_allocation_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  allocation_id uuid not null,
  receipt_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity <> 0),
  delivered_by text not null check (btrim(delivered_by) <> ''),
  delivered_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, allocation_id) references public.ordering_receipt_allocations (tenant_id, id)
);
-- 주문 취소로 풀린 배분의 처분 대기 기록(ST-C01). 아직 명령은 영속화하지 않았고 잔량 계산이 읽는다.
create table public.ordering_allocation_cancellations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  book_key text not null check (btrim(book_key) <> ''),
  receipt_id uuid not null,
  allocation_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  cancelled_by text not null check (btrim(cancelled_by) <> ''),
  cancelled_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, allocation_id) references public.ordering_receipt_allocations (tenant_id, id)
);

create trigger ordering_po_replies_append_only before update or delete on public.ordering_po_replies
  for each row execute function private.forbid_mutation();
create trigger ordering_po_cancellation_requests_append_only before update or delete on public.ordering_po_cancellation_requests
  for each row execute function private.forbid_mutation();
create trigger ordering_po_cancellation_responses_append_only before update or delete on public.ordering_po_cancellation_responses
  for each row execute function private.forbid_mutation();
create trigger ordering_goods_receipts_append_only before update or delete on public.ordering_goods_receipts
  for each row execute function private.forbid_mutation();
create trigger ordering_receipt_corrections_append_only before update or delete on public.ordering_receipt_corrections
  for each row execute function private.forbid_mutation();
create trigger ordering_receipt_allocations_append_only before update or delete on public.ordering_receipt_allocations
  for each row execute function private.forbid_mutation();
create trigger ordering_allocation_releases_append_only before update or delete on public.ordering_allocation_releases
  for each row execute function private.forbid_mutation();
create trigger ordering_allocation_deliveries_append_only before update or delete on public.ordering_allocation_deliveries
  for each row execute function private.forbid_mutation();
create trigger ordering_allocation_cancellations_append_only before update or delete on public.ordering_allocation_cancellations
  for each row execute function private.forbid_mutation();

-- 입고 가드: 발주가 SENT·ACKNOWLEDGED이고, 정상 입고 순량 합계가 유효 발주량(품목 수량 - 품절 확정 - 수락된 취소)을 넘지 않는다.
create function private.guard_goods_receipt_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  po_status text;
  line_qty int;
  reduced bigint;
  net_received bigint;
begin
  select status into po_status from public.ordering_purchase_orders where tenant_id = new.tenant_id and id = new.purchase_order_id;
  if not found then return new; end if;
  select quantity into line_qty from public.ordering_po_lines where tenant_id = new.tenant_id and id = new.po_line_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('pol:' || new.tenant_id::text || ':' || new.po_line_id::text, 0));
  if po_status not in ('SENT', 'ACKNOWLEDGED') then
    raise exception 'goods can only be received for a SENT or ACKNOWLEDGED purchase order' using errcode = 'P0001';
  end if;
  select coalesce((select sum(quantity) from public.ordering_po_replies
                    where tenant_id = new.tenant_id and po_line_id = new.po_line_id and kind = 'OUT_OF_STOCK'), 0)
       + coalesce((select sum(accepted_quantity) from public.ordering_po_cancellation_responses
                    where tenant_id = new.tenant_id and po_line_id = new.po_line_id), 0)
    into reduced;
  select coalesce((select sum(normal_quantity) from public.ordering_goods_receipts
                    where tenant_id = new.tenant_id and po_line_id = new.po_line_id), 0)
       - coalesce((select sum(c.quantity) from public.ordering_receipt_corrections c
                    join public.ordering_goods_receipts r on r.tenant_id = c.tenant_id and r.id = c.receipt_id
                   where r.tenant_id = new.tenant_id and r.po_line_id = new.po_line_id), 0)
    into net_received;
  if new.normal_quantity > greatest(0, line_qty - reduced - net_received) then
    raise exception 'normal received quantity must not exceed the valid purchase order quantity' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_goods_receipts_guard_insert before insert on public.ordering_goods_receipts
  for each row execute function private.guard_goods_receipt_insert();

-- 배분 가드: 입고 정상 순량 이내이고, 주문 품목의 발주 연결 수량 이내다. 순배분은 배분 - 해제다(인도는 배분에 남는다).
create function private.guard_receipt_allocation_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  rc record;
  net_normal bigint;
  allocated bigint;
  for_line bigint;
  link_qty bigint;
begin
  select po_line_id, normal_quantity into rc from public.ordering_goods_receipts where tenant_id = new.tenant_id and id = new.receipt_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('pol:' || new.tenant_id::text || ':' || rc.po_line_id::text, 0));
  select rc.normal_quantity - coalesce(sum(quantity), 0) into net_normal
    from public.ordering_receipt_corrections where tenant_id = new.tenant_id and receipt_id = new.receipt_id;
  select coalesce(sum(a.quantity), 0) - coalesce((select sum(r.quantity) from public.ordering_allocation_releases r
                                                   join public.ordering_receipt_allocations x on x.tenant_id = r.tenant_id and x.id = r.allocation_id
                                                  where x.tenant_id = new.tenant_id and x.receipt_id = new.receipt_id), 0)
    into allocated
    from public.ordering_receipt_allocations a where a.tenant_id = new.tenant_id and a.receipt_id = new.receipt_id;
  if allocated + new.quantity > net_normal then
    raise exception 'allocated quantity must not exceed the receipt normal quantity' using errcode = 'P0001';
  end if;
  select coalesce(sum(quantity), 0) into link_qty from public.ordering_po_links
   where tenant_id = new.tenant_id and po_line_id = rc.po_line_id and order_id = new.order_id and order_line_id = new.order_line_id;
  if link_qty = 0 then
    raise exception 'order line is not linked to the receipt purchase order line' using errcode = 'P0001';
  end if;
  select coalesce(sum(a.quantity), 0) - coalesce((select sum(r.quantity) from public.ordering_allocation_releases r
                                                   join public.ordering_receipt_allocations x on x.tenant_id = r.tenant_id and x.id = r.allocation_id
                                                   join public.ordering_goods_receipts g on g.tenant_id = x.tenant_id and g.id = x.receipt_id
                                                  where x.tenant_id = new.tenant_id and g.po_line_id = rc.po_line_id
                                                    and x.order_id = new.order_id and x.order_line_id = new.order_line_id), 0)
    into for_line
    from public.ordering_receipt_allocations a join public.ordering_goods_receipts g on g.tenant_id = a.tenant_id and g.id = a.receipt_id
   where a.tenant_id = new.tenant_id and g.po_line_id = rc.po_line_id and a.order_id = new.order_id and a.order_line_id = new.order_line_id;
  if for_line + new.quantity > link_qty then
    raise exception 'allocated quantity must not exceed the order line purchase order link quantity' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_receipt_allocations_guard_insert before insert on public.ordering_receipt_allocations
  for each row execute function private.guard_receipt_allocation_insert();

-- 해제·인도 가드: 배분 잔량(배분 - 해제 - 인도 - 취소 처분)을 넘지 않고, 인도 정정은 인도한 것보다 많이 되돌리지 않는다.
create function private.guard_allocation_movement_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  al record;
  po_line uuid;
  released bigint;
  delivered bigint;
  cancelled bigint;
begin
  select receipt_id, quantity into al from public.ordering_receipt_allocations where tenant_id = new.tenant_id and id = new.allocation_id;
  if not found then return new; end if;
  select po_line_id into po_line from public.ordering_goods_receipts where tenant_id = new.tenant_id and id = al.receipt_id;
  perform pg_advisory_xact_lock(hashtextextended('pol:' || new.tenant_id::text || ':' || po_line::text, 0));
  select coalesce(sum(quantity), 0) into released from public.ordering_allocation_releases where tenant_id = new.tenant_id and allocation_id = new.allocation_id;
  select coalesce(sum(quantity), 0) into delivered from public.ordering_allocation_deliveries where tenant_id = new.tenant_id and allocation_id = new.allocation_id;
  select coalesce(sum(quantity), 0) into cancelled from public.ordering_allocation_cancellations where tenant_id = new.tenant_id and allocation_id = new.allocation_id;
  if tg_table_name = 'ordering_allocation_deliveries' and delivered + new.quantity < 0 then
    raise exception 'a delivery correction cannot take back more than was delivered' using errcode = 'P0001';
  end if;
  if new.quantity > 0 and new.quantity > al.quantity - released - delivered - cancelled then
    raise exception 'the quantity must not exceed the allocation remaining quantity' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_allocation_releases_guard_insert before insert on public.ordering_allocation_releases
  for each row execute function private.guard_allocation_movement_insert();
create trigger ordering_allocation_deliveries_guard_insert before insert on public.ordering_allocation_deliveries
  for each row execute function private.guard_allocation_movement_insert();

-- 권한: 같은 서점의 활성 멤버는 읽고, 쓰기는 서버 경로(service_role)만 한다. 발주 상태는 별도 명령이 갱신한다.
alter table public.ordering_purchase_orders enable row level security;
alter table public.ordering_po_lines enable row level security;
alter table public.ordering_po_links enable row level security;
alter table public.ordering_po_replies enable row level security;
alter table public.ordering_po_cancellation_requests enable row level security;
alter table public.ordering_po_cancellation_responses enable row level security;
alter table public.ordering_goods_receipts enable row level security;
alter table public.ordering_receipt_corrections enable row level security;
alter table public.ordering_receipt_allocations enable row level security;
alter table public.ordering_allocation_releases enable row level security;
alter table public.ordering_allocation_deliveries enable row level security;
alter table public.ordering_allocation_cancellations enable row level security;
revoke all on public.ordering_purchase_orders, public.ordering_po_lines, public.ordering_po_links, public.ordering_po_replies,
  public.ordering_po_cancellation_requests, public.ordering_po_cancellation_responses, public.ordering_goods_receipts,
  public.ordering_receipt_corrections, public.ordering_receipt_allocations, public.ordering_allocation_releases,
  public.ordering_allocation_deliveries, public.ordering_allocation_cancellations from public, anon, authenticated;
grant select on public.ordering_purchase_orders, public.ordering_po_lines, public.ordering_po_links, public.ordering_po_replies,
  public.ordering_po_cancellation_requests, public.ordering_po_cancellation_responses, public.ordering_goods_receipts,
  public.ordering_receipt_corrections, public.ordering_receipt_allocations, public.ordering_allocation_releases,
  public.ordering_allocation_deliveries, public.ordering_allocation_cancellations to authenticated;
grant select, insert on public.ordering_po_lines, public.ordering_po_links, public.ordering_po_replies,
  public.ordering_po_cancellation_requests, public.ordering_po_cancellation_responses, public.ordering_goods_receipts,
  public.ordering_receipt_corrections, public.ordering_receipt_allocations, public.ordering_allocation_releases,
  public.ordering_allocation_deliveries, public.ordering_allocation_cancellations to service_role;
grant select, insert, update on public.ordering_purchase_orders to service_role;

create policy ordering_purchase_orders_select on public.ordering_purchase_orders for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_po_lines_select on public.ordering_po_lines for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_po_links_select on public.ordering_po_links for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_po_replies_select on public.ordering_po_replies for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_po_cancellation_requests_select on public.ordering_po_cancellation_requests for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_po_cancellation_responses_select on public.ordering_po_cancellation_responses for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_goods_receipts_select on public.ordering_goods_receipts for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_receipt_corrections_select on public.ordering_receipt_corrections for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_receipt_allocations_select on public.ordering_receipt_allocations for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_allocation_releases_select on public.ordering_allocation_releases for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_allocation_deliveries_select on public.ordering_allocation_deliveries for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_allocation_cancellations_select on public.ordering_allocation_cancellations for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
