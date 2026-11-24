-- 006 수령(인도)·주문 취소 요청
-- 락 순서(데드락 방지): 주문 행(FOR SHARE) -> 주문 인도 락('ful:<서점>:<주문>') -> 책 락('<서점>:<책>').
-- 수령(인도)과 취소 요청은 같은 주문 인도 락으로 직렬화해 "인도 vs 취소 요청 잠금(D27)" 경쟁을 막는다.
-- 트리거 함수는 호출자(service_role) 권한으로 실행되므로 private 스키마의 다른 함수를 부르지 않고 락을 직접 잡는다.

-- 수령(인도) 원장. 정정(ST-F02)은 수량·금액이 음수인 행으로 추가한다. 원 수령은 바꾸지 않는다.
create table public.ordering_fulfillments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  order_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity <> 0),
  unit_price_krw bigint not null check (unit_price_krw >= 0),
  amount_krw bigint not null,
  sources jsonb not null default '[]'::jsonb,
  received_by text not null check (btrim(received_by) <> ''),
  received_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  corrects_fulfillment_id uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, order_id, order_line_id)
    references public.ordering_order_lines (tenant_id, order_id, id),
  foreign key (tenant_id, corrects_fulfillment_id) references public.ordering_fulfillments (tenant_id, id)
);
create index ordering_fulfillments_order_idx on public.ordering_fulfillments (tenant_id, order_id);

-- 주문 취소 요청과 상태 전이 기록. 상태는 마지막 결정에서 파생한다(BR-O05).
create table public.ordering_order_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  order_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  base_version bigint not null check (base_version >= 1),
  requested_by text not null check (btrim(requested_by) <> ''),
  requested_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id, order_line_id)
    references public.ordering_order_lines (tenant_id, order_id, id)
);
create table public.ordering_order_cancellation_decisions (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  tenant_id uuid not null,
  request_id uuid not null,
  kind text not null check (kind in ('APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE', 'APPLIED')),
  decided_by text not null check (btrim(decided_by) <> ''),
  decided_at timestamptz not null,
  note text,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, request_id) references public.ordering_order_cancellation_requests (tenant_id, id)
);
create index ordering_order_cancellation_decisions_request_idx on public.ordering_order_cancellation_decisions (tenant_id, request_id, seq);

create trigger ordering_fulfillments_append_only before update or delete on public.ordering_fulfillments
  for each row execute function private.forbid_mutation();
create trigger ordering_order_cancellation_requests_append_only before update or delete on public.ordering_order_cancellation_requests
  for each row execute function private.forbid_mutation();
create trigger ordering_order_cancellation_decisions_append_only before update or delete on public.ordering_order_cancellation_decisions
  for each row execute function private.forbid_mutation();

-- 수령 가드: 품목의 인도 가능량(= 품목 수량 - 순 수령 - 진행 중 취소 요청 잠금)과 확인된 결제액을 넘지 않는다.
-- 진행 중 취소 요청은 마지막 결정이 없거나 APPROVED인 요청이다(D27).
create function private.guard_fulfillment_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  line_qty int;
  net int;
  locked bigint;
  delivered_amount bigint;
  confirmed bigint;
begin
  select quantity into line_qty from public.ordering_order_lines where tenant_id = new.tenant_id and id = new.order_line_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('ful:' || new.tenant_id::text || ':' || new.order_id::text, 0));
  select coalesce(sum(quantity), 0) into net from public.ordering_fulfillments
   where tenant_id = new.tenant_id and order_line_id = new.order_line_id;
  if net + new.quantity < 0 then
    raise exception 'a correction cannot take back more than was delivered' using errcode = 'P0001';
  end if;
  if new.quantity > 0 then
    select coalesce(sum(r.quantity), 0) into locked
      from public.ordering_order_cancellation_requests r
     where r.tenant_id = new.tenant_id and r.order_line_id = new.order_line_id
       and coalesce((select d.kind from public.ordering_order_cancellation_decisions d
                      where d.tenant_id = r.tenant_id and d.request_id = r.id order by d.seq desc limit 1), 'REQUESTED')
           in ('REQUESTED', 'APPROVED');
    if net + new.quantity > line_qty - locked then
      raise exception 'delivery quantity must not exceed the order line unlocked undelivered quantity' using errcode = 'P0001';
    end if;
    select coalesce(sum(amount_krw), 0) into delivered_amount from public.ordering_fulfillments
     where tenant_id = new.tenant_id and order_id = new.order_id;
    select coalesce(sum(p.amount_krw), 0) into confirmed
      from public.ordering_payments p
     where p.tenant_id = new.tenant_id and p.order_id = new.order_id
       and exists (select 1 from public.ordering_payment_confirmations c where c.tenant_id = p.tenant_id and c.payment_id = p.id)
       and not exists (select 1 from public.ordering_payment_voids v where v.tenant_id = p.tenant_id and v.payment_id = p.id);
    if delivered_amount + new.amount_krw > confirmed then
      raise exception 'confirmed payment does not cover the delivery amount' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger ordering_fulfillments_guard_insert before insert on public.ordering_fulfillments
  for each row execute function private.guard_fulfillment_insert();

-- 취소 요청 가드: 주문이 열려 있고(확정·미종결·미전량취소), 확인한 version이 현재와 같고, 요청 수량이
-- 미인도·미잠금 수량 이내여야 한다. 인도와 같은 주문 인도 락으로 직렬화된다.
create function private.guard_order_cancellation_request_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  o record;
  line_qty int;
  net int;
  locked bigint;
begin
  select status, version, closed_at, cancelled_at into o from public.ordering_orders where tenant_id = new.tenant_id and id = new.order_id;
  if not found then return new; end if;
  select quantity into line_qty from public.ordering_order_lines where tenant_id = new.tenant_id and id = new.order_line_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('ful:' || new.tenant_id::text || ':' || new.order_id::text, 0));
  if o.status <> 'CONFIRMED' or o.closed_at is not null or o.cancelled_at is not null then
    raise exception 'a cancellation can only be requested for an open confirmed order' using errcode = 'P0001';
  end if;
  if o.version <> new.base_version then
    raise exception 'the order changed since the cancellation request was based on it' using errcode = 'P0001';
  end if;
  select coalesce(sum(quantity), 0) into net from public.ordering_fulfillments
   where tenant_id = new.tenant_id and order_line_id = new.order_line_id;
  select coalesce(sum(r.quantity), 0) into locked
    from public.ordering_order_cancellation_requests r
   where r.tenant_id = new.tenant_id and r.order_line_id = new.order_line_id
     and coalesce((select d.kind from public.ordering_order_cancellation_decisions d
                    where d.tenant_id = r.tenant_id and d.request_id = r.id order by d.seq desc limit 1), 'REQUESTED')
         in ('REQUESTED', 'APPROVED');
  if new.quantity > line_qty - net - locked then
    raise exception 'cancellation quantity must not exceed the undelivered, unlocked quantity' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_order_cancellation_requests_guard_insert before insert on public.ordering_order_cancellation_requests
  for each row execute function private.guard_order_cancellation_request_insert();

-- 예약 인도·해제 가드: 같은 책 락 아래에서 예약 잔량(예약 - 해제 - 인도)을 넘지 않고, 인도 정정이 인도량보다 많이 되돌리지 않는다.
create function private.guard_stock_reservation_delivery_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  res record;
  released bigint;
  delivered bigint;
begin
  select book_key, quantity into res from public.ordering_stock_reservations where tenant_id = new.tenant_id and id = new.reservation_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':' || res.book_key, 0));
  select coalesce(sum(quantity), 0) into released from public.ordering_stock_reservation_releases where tenant_id = new.tenant_id and reservation_id = new.reservation_id;
  select coalesce(sum(quantity), 0) into delivered from public.ordering_stock_reservation_deliveries where tenant_id = new.tenant_id and reservation_id = new.reservation_id;
  if delivered + new.quantity < 0 then
    raise exception 'a delivery correction cannot take back more than was delivered' using errcode = 'P0001';
  end if;
  if new.quantity > 0 and delivered + new.quantity > res.quantity - released then
    raise exception 'delivered quantity must not exceed the reservation remaining quantity' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_stock_reservation_deliveries_guard_insert before insert on public.ordering_stock_reservation_deliveries
  for each row execute function private.guard_stock_reservation_delivery_insert();

create function private.guard_stock_reservation_release_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  res record;
  released bigint;
  delivered bigint;
begin
  select book_key, quantity into res from public.ordering_stock_reservations where tenant_id = new.tenant_id and id = new.reservation_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':' || res.book_key, 0));
  select coalesce(sum(quantity), 0) into released from public.ordering_stock_reservation_releases where tenant_id = new.tenant_id and reservation_id = new.reservation_id;
  select coalesce(sum(quantity), 0) into delivered from public.ordering_stock_reservation_deliveries where tenant_id = new.tenant_id and reservation_id = new.reservation_id;
  if released + new.quantity > res.quantity - delivered then
    raise exception 'released quantity must not exceed the reservation remaining quantity' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_stock_reservation_releases_guard_insert before insert on public.ordering_stock_reservation_releases
  for each row execute function private.guard_stock_reservation_release_insert();

-- 재고 출고(OUT)는 보유 재고 아래로 내려갈 수 없다. 같은 책 락 아래에서 검사한다.
create function private.guard_stock_movement_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  on_hand bigint;
begin
  if new.direction <> 'OUT' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':' || new.book_key, 0));
  select coalesce(sum(case direction when 'IN' then quantity else -quantity end), 0) into on_hand
    from public.ordering_stock_movements where tenant_id = new.tenant_id and book_key = new.book_key;
  if new.quantity > on_hand then
    raise exception 'stock cannot go below zero' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_stock_movements_guard_insert before insert on public.ordering_stock_movements
  for each row execute function private.guard_stock_movement_insert();

-- 권한: 수령·취소 요청은 서버 경로(service_role)만 쓰고, 같은 서점의 활성 멤버는 읽을 수 있다. 결제와 달리 증빙·개인정보가 없다.
alter table public.ordering_fulfillments enable row level security;
alter table public.ordering_order_cancellation_requests enable row level security;
alter table public.ordering_order_cancellation_decisions enable row level security;
revoke all on public.ordering_fulfillments, public.ordering_order_cancellation_requests, public.ordering_order_cancellation_decisions
  from public, anon, authenticated;
grant select on public.ordering_fulfillments, public.ordering_order_cancellation_requests, public.ordering_order_cancellation_decisions to authenticated;
grant select, insert on public.ordering_fulfillments, public.ordering_order_cancellation_requests, public.ordering_order_cancellation_decisions to service_role;

create policy ordering_fulfillments_select on public.ordering_fulfillments
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_order_cancellation_requests_select on public.ordering_order_cancellation_requests
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_order_cancellation_decisions_select on public.ordering_order_cancellation_decisions
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
