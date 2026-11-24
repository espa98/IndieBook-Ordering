-- 004 재고: 수불 원장·예약·해제·인도·조달 배정
-- 원장(이동·예약·해제·인도)은 추가 전용이다. 잔량·가용량은 저장하지 않고 기록에서 파생한다(BR-Q09, BR-Q16).
-- 예약은 책 단위 경합이라 (서점, 책)으로 트랜잭션 어드바이저리 락을 잡고, 같은 락을 트리거도 잡아
-- 어댑터를 거치지 않는 쓰기도 "예약 합계 <= 보유 재고"를 지킨다.

-- 복합 FK를 위해 품목에 (서점, 주문, 품목) 유일 키를 더한다
alter table public.ordering_order_lines
  add constraint ordering_order_lines_tenant_order_id_uq unique (tenant_id, order_id, id);

-- 원장 테이블의 수정·삭제를 막는 공용 트리거 함수
create function private.forbid_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

-- 매장 재고 수불 원장. 수량은 항상 양수이고 방향을 따로 둔다(BR-Q22).
create table public.ordering_stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  book_key text not null check (btrim(book_key) <> ''),
  kind text not null check (kind in ('INITIAL', 'ADJUST', 'DELIVERY', 'DELIVERY_REVERSAL', 'CANCEL_TO_STOCK')),
  direction text not null check (direction in ('IN', 'OUT')),
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  reservation_id uuid,
  cancellation_id uuid,
  acted_by text not null check (btrim(acted_by) <> ''),
  acted_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index ordering_stock_movements_book_idx on public.ordering_stock_movements (tenant_id, book_key);
create trigger ordering_stock_movements_append_only
  before update or delete on public.ordering_stock_movements
  for each row execute function private.forbid_mutation();

-- 조달 배정: 주문 품목의 수량 일부를 공급처 발주 경로로 지정한 계획량. 예약의 미배정량 계산이 읽는다.
create table public.ordering_sourcing_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  order_id uuid not null,
  order_line_id uuid not null,
  supplier_code text not null check (btrim(supplier_code) <> ''),
  quantity int not null check (quantity >= 1),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'RELEASED')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id, order_line_id)
    references public.ordering_order_lines (tenant_id, order_id, id)
);

-- 재고 예약 (ST-I03)
create table public.ordering_stock_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  book_key text not null check (btrim(book_key) <> ''),
  order_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity >= 1),
  reserved_by text not null check (btrim(reserved_by) <> ''),
  reserved_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id, order_line_id)
    references public.ordering_order_lines (tenant_id, order_id, id)
);
create index ordering_stock_reservations_book_idx on public.ordering_stock_reservations (tenant_id, book_key);
create index ordering_stock_reservations_line_idx on public.ordering_stock_reservations (tenant_id, order_line_id);

-- 해제(ST-I04)와 인도(ST-I05, 정정은 음수 수량). 원 예약은 바꾸지 않는다.
create table public.ordering_stock_reservation_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  reservation_id uuid not null,
  quantity int not null check (quantity >= 1),
  reason text not null check (btrim(reason) <> ''),
  released_by text not null check (btrim(released_by) <> ''),
  released_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, reservation_id) references public.ordering_stock_reservations (tenant_id, id)
);
create table public.ordering_stock_reservation_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  reservation_id uuid not null,
  quantity int not null check (quantity <> 0),
  delivered_by text not null check (btrim(delivered_by) <> ''),
  delivered_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, reservation_id) references public.ordering_stock_reservations (tenant_id, id)
);

create trigger ordering_stock_reservations_append_only
  before update or delete on public.ordering_stock_reservations
  for each row execute function private.forbid_mutation();
create trigger ordering_stock_reservation_releases_append_only
  before update or delete on public.ordering_stock_reservation_releases
  for each row execute function private.forbid_mutation();
create trigger ordering_stock_reservation_deliveries_append_only
  before update or delete on public.ordering_stock_reservation_deliveries
  for each row execute function private.forbid_mutation();

-- 예약 INSERT 가드: (서점, 책) 락을 잡고, 품목의 책과 예약의 책이 같고, 예약 합계가 보유 재고를 넘지 않는지 확인한다.
create function private.guard_stock_reservation_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  line_book text;
  on_hand bigint;
  reserved bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':' || new.book_key, 0));
  select book_key into line_book
    from public.ordering_order_lines
   where tenant_id = new.tenant_id and id = new.order_line_id;
  -- 품목이 없으면(다른 서점의 품목을 가리키는 등) 복합 FK가 거부하도록 맡긴다
  if not found then
    return new;
  end if;
  if line_book is distinct from new.book_key then
    raise exception 'the reservation book does not match the order line book' using errcode = 'P0001';
  end if;
  select coalesce(sum(case direction when 'IN' then quantity else -quantity end), 0) into on_hand
    from public.ordering_stock_movements
   where tenant_id = new.tenant_id and book_key = new.book_key;
  select coalesce(sum(r.quantity), 0)
         - coalesce((select sum(rel.quantity) from public.ordering_stock_reservation_releases rel
                       join public.ordering_stock_reservations rr on rr.tenant_id = rel.tenant_id and rr.id = rel.reservation_id
                      where rr.tenant_id = new.tenant_id and rr.book_key = new.book_key), 0)
         - coalesce((select sum(d.quantity) from public.ordering_stock_reservation_deliveries d
                       join public.ordering_stock_reservations rr on rr.tenant_id = d.tenant_id and rr.id = d.reservation_id
                      where rr.tenant_id = new.tenant_id and rr.book_key = new.book_key), 0)
    into reserved
    from public.ordering_stock_reservations r
   where r.tenant_id = new.tenant_id and r.book_key = new.book_key;
  if new.quantity > on_hand - reserved then
    raise exception 'reserved quantity must not exceed the available stock' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_stock_reservations_guard_insert
  before insert on public.ordering_stock_reservations
  for each row execute function private.guard_stock_reservation_insert();

-- 권한·RLS: 재고 조회는 같은 서점의 활성 멤버, 쓰기는 서버 경로(service_role)만.
alter table public.ordering_stock_movements enable row level security;
alter table public.ordering_sourcing_allocations enable row level security;
alter table public.ordering_stock_reservations enable row level security;
alter table public.ordering_stock_reservation_releases enable row level security;
alter table public.ordering_stock_reservation_deliveries enable row level security;
revoke all on public.ordering_stock_movements, public.ordering_sourcing_allocations, public.ordering_stock_reservations,
  public.ordering_stock_reservation_releases, public.ordering_stock_reservation_deliveries from public, anon, authenticated;
grant select on public.ordering_stock_movements, public.ordering_sourcing_allocations, public.ordering_stock_reservations,
  public.ordering_stock_reservation_releases, public.ordering_stock_reservation_deliveries to authenticated;
grant select, insert on public.ordering_stock_movements, public.ordering_stock_reservations,
  public.ordering_stock_reservation_releases, public.ordering_stock_reservation_deliveries to service_role;
grant select, insert, update on public.ordering_sourcing_allocations to service_role;

create policy ordering_stock_movements_select on public.ordering_stock_movements
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_sourcing_allocations_select on public.ordering_sourcing_allocations
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_stock_reservations_select on public.ordering_stock_reservations
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_stock_reservation_releases_select on public.ordering_stock_reservation_releases
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_stock_reservation_deliveries_select on public.ordering_stock_reservation_deliveries
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
