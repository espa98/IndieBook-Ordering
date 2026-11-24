-- 008 주문 취소 적용·종결
-- 1) 주문 품목 수량은 인도한 수량보다 적게 줄일 수 없다(취소 적용이 어댑터를 거치지 않아도 DB가 막는다).
-- 2) 종결·전량 취소된 주문에는 결제·재고 예약·인도(정정 제외)를 새로 넣을 수 없다.
-- 3) 종결 판정이 읽는 처분(재고 편입·반품) 기록은 읽기 스키마만 만든다. 그 명령들은 아직 영속화하지 않았다.
-- 4) 종결 요청·실행 기록(추가 전용).
-- 락 순서: 주문 행 -> 주문 인도 락('ful:') -> 책 락 -> 발주 품목 락('pol:'). 결제 락('pay:')은 트리거가 가장 마지막에 잡는다.

-- 1) 품목 갱신 가드 교체: 수량 감소만 허용하되 순 수령 아래로는 내릴 수 없다.
create or replace function private.guard_order_line_update() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  delivered bigint;
begin
  if (new.id, new.tenant_id, new.order_id, new.position, new.book_key, new.unit_price_krw)
       is distinct from (old.id, old.tenant_id, old.order_id, old.position, old.book_key, old.unit_price_krw)
     or (new.book_title, new.book_isbn, new.list_price_krw)
       is distinct from (old.book_title, old.book_isbn, old.list_price_krw) then
    raise exception 'only the quantity of an order line can change' using errcode = 'P0001';
  end if;
  if new.quantity > old.quantity then
    raise exception 'an order line quantity can only decrease' using errcode = 'P0001';
  end if;
  if new.quantity < old.quantity then
    perform pg_advisory_xact_lock(hashtextextended('ful:' || new.tenant_id::text || ':' || new.order_id::text, 0));
    select coalesce(sum(quantity), 0) into delivered from public.ordering_fulfillments
     where tenant_id = new.tenant_id and order_line_id = new.id;
    if new.quantity < delivered then
      raise exception 'an order line quantity cannot go below the delivered quantity' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- 2) 열린 주문에만 새 거래를 받는다: 확정되었고 종결·전량 취소되지 않았을 것. 주문 행을 공유 잠금해 동시 종결과 경쟁해도 종결 뒤에는 들어가지 않는다.
create function private.guard_order_open_for_transactions() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  o record;
begin
  -- 수령 정정(음수 수량)은 종결된 주문에도 할 수 있다(ST-F02)
  -- plpgsql은 and의 단락 평가를 보장하지 않고 레코드에 없는 필드 접근은 오류이므로 중첩한다
  if tg_table_name = 'ordering_fulfillments' then
    if new.quantity < 0 then
      return new;
    end if;
  end if;
  select status, closed_at, cancelled_at into o from public.ordering_orders
   where tenant_id = new.tenant_id and id = new.order_id
     for share;
  if not found then return new; end if; -- 주문이 없으면 복합 FK가 거부한다
  if o.status <> 'CONFIRMED' or o.closed_at is not null or o.cancelled_at is not null then
    raise exception 'the order is not open for new transactions' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_payments_guard_order_open before insert on public.ordering_payments
  for each row execute function private.guard_order_open_for_transactions();
create trigger ordering_stock_reservations_guard_order_open before insert on public.ordering_stock_reservations
  for each row execute function private.guard_order_open_for_transactions();
create trigger ordering_fulfillments_guard_order_open before insert on public.ordering_fulfillments
  for each row execute function private.guard_order_open_for_transactions();

-- 취소 요청의 결정 순서(BR-O05): REQUESTED -> APPROVED·REJECTED·WITHDRAWN, APPROVED -> APPLIED·STALE, 나머지는 종결 상태다.
-- 같은 주문의 인도 락 아래에서 마지막 상태를 읽어 검사하므로, 같은 승인 요청을 두 세션이 동시에 적용해도 한 번만 들어간다.
create function private.guard_order_cancellation_decision_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  req_order uuid;
  current_kind text;
begin
  select order_id into req_order from public.ordering_order_cancellation_requests where tenant_id = new.tenant_id and id = new.request_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('ful:' || new.tenant_id::text || ':' || req_order::text, 0));
  select kind into current_kind from public.ordering_order_cancellation_decisions
   where tenant_id = new.tenant_id and request_id = new.request_id order by seq desc limit 1;
  current_kind := coalesce(current_kind, 'REQUESTED');
  if not ((current_kind = 'REQUESTED' and new.kind in ('APPROVED', 'REJECTED', 'WITHDRAWN'))
       or (current_kind = 'APPROVED' and new.kind in ('APPLIED', 'STALE'))) then
    raise exception 'the cancellation request cannot move from % to %', current_kind, new.kind using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_order_cancellation_decisions_guard_insert before insert on public.ordering_order_cancellation_decisions
  for each row execute function private.guard_order_cancellation_decision_insert();

-- 3) 처분 기록(읽기 스키마): 주문 취소로 풀린 입고 배분의 재고 편입·반품. 종결 판정의 "처분 미해소" 계산이 읽는다.
create table public.ordering_stock_intakes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  cancellation_id uuid not null,
  quantity int not null check (quantity >= 1),
  acted_by text not null check (btrim(acted_by) <> ''),
  acted_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, cancellation_id) references public.ordering_allocation_cancellations (tenant_id, id)
);
create table public.ordering_return_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  cancellation_id uuid not null,
  quantity int not null check (quantity >= 1),
  requested_by text not null check (btrim(requested_by) <> ''),
  requested_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, cancellation_id) references public.ordering_allocation_cancellations (tenant_id, id)
);
create table public.ordering_return_completions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  return_request_id uuid not null,
  quantity int not null check (quantity >= 1),
  confirmed_by text not null check (btrim(confirmed_by) <> ''),
  confirmed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, return_request_id) references public.ordering_return_requests (tenant_id, id)
);
create table public.ordering_return_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  return_request_id uuid not null,
  quantity int not null check (quantity >= 1),
  kind text not null check (btrim(kind) <> ''),
  reported_by text not null check (btrim(reported_by) <> ''),
  reported_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, return_request_id) references public.ordering_return_requests (tenant_id, id)
);
create table public.ordering_return_exception_resolutions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  return_exception_id uuid not null,
  outcome text not null check (outcome in ('RECOVERED', 'RETURNED')),
  quantity int not null check (quantity >= 1),
  resolved_by text not null check (btrim(resolved_by) <> ''),
  resolved_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, return_exception_id) references public.ordering_return_exceptions (tenant_id, id)
);

-- 4) 종결 요청(Staff)과 서버의 종결 실행 기록. 상태는 주문의 closed_at이고 요청·실행은 근거 기록이다.
create table public.ordering_order_closure_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  expected_version bigint not null check (expected_version >= 1),
  requested_by text not null check (btrim(requested_by) <> ''),
  requested_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id)
);
create table public.ordering_order_closures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  closure_request_id uuid not null,
  order_version_before bigint not null,
  order_version_after bigint not null,
  executed_by text not null check (executed_by = 'SYSTEM'),
  outcome text check (outcome is null or outcome = 'CANCELLED'),
  closed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (order_version_after = order_version_before + 1),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id),
  foreign key (tenant_id, closure_request_id) references public.ordering_order_closure_requests (tenant_id, id)
);

create trigger ordering_stock_intakes_append_only before update or delete on public.ordering_stock_intakes
  for each row execute function private.forbid_mutation();
create trigger ordering_return_requests_append_only before update or delete on public.ordering_return_requests
  for each row execute function private.forbid_mutation();
create trigger ordering_return_completions_append_only before update or delete on public.ordering_return_completions
  for each row execute function private.forbid_mutation();
create trigger ordering_return_exceptions_append_only before update or delete on public.ordering_return_exceptions
  for each row execute function private.forbid_mutation();
create trigger ordering_return_exception_resolutions_append_only before update or delete on public.ordering_return_exception_resolutions
  for each row execute function private.forbid_mutation();
create trigger ordering_order_closure_requests_append_only before update or delete on public.ordering_order_closure_requests
  for each row execute function private.forbid_mutation();
create trigger ordering_order_closures_append_only before update or delete on public.ordering_order_closures
  for each row execute function private.forbid_mutation();

alter table public.ordering_stock_intakes enable row level security;
alter table public.ordering_return_requests enable row level security;
alter table public.ordering_return_completions enable row level security;
alter table public.ordering_return_exceptions enable row level security;
alter table public.ordering_return_exception_resolutions enable row level security;
alter table public.ordering_order_closure_requests enable row level security;
alter table public.ordering_order_closures enable row level security;
revoke all on public.ordering_stock_intakes, public.ordering_return_requests, public.ordering_return_completions,
  public.ordering_return_exceptions, public.ordering_return_exception_resolutions,
  public.ordering_order_closure_requests, public.ordering_order_closures from public, anon, authenticated;
grant select on public.ordering_stock_intakes, public.ordering_return_requests, public.ordering_return_completions,
  public.ordering_return_exceptions, public.ordering_return_exception_resolutions,
  public.ordering_order_closure_requests, public.ordering_order_closures to authenticated;
grant select, insert on public.ordering_stock_intakes, public.ordering_return_requests, public.ordering_return_completions,
  public.ordering_return_exceptions, public.ordering_return_exception_resolutions,
  public.ordering_order_closure_requests, public.ordering_order_closures to service_role;

create policy ordering_stock_intakes_select on public.ordering_stock_intakes for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_return_requests_select on public.ordering_return_requests for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_return_completions_select on public.ordering_return_completions for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_return_exceptions_select on public.ordering_return_exceptions for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_return_exception_resolutions_select on public.ordering_return_exception_resolutions for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_order_closure_requests_select on public.ordering_order_closure_requests for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_order_closures_select on public.ordering_order_closures for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
