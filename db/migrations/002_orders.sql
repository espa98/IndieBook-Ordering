-- 002 주문·품목: 도메인 불변식을 DB에서도 강제한다. 도메인 코드는 먼저 검증하고, 여기서는 경쟁·우회에도 깨지지 않게 막는다.
-- ERD V2.1과의 차이: 품목 `book_key`는 ERD와 같고, 취소 적용으로 수량을 제자리에서 줄이는 승인된 해석(I28)에 따라
-- `ordered_qty/cancelled_qty` 대신 `quantity` 하나를 쓴다. 표시번호·합계는 확정 주문만 가진다.

create table public.ordering_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'CONFIRMED')),
  version bigint not null default 1 check (version >= 1),
  display_number bigint check (display_number is null or display_number >= 1),
  total_krw bigint check (total_krw is null or total_krw >= 0),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  cancelled_at timestamptz,
  -- 자식 테이블의 복합 FK 대상 (RLS-04)
  unique (tenant_id, id),
  -- 확정 주문만 표시번호·합계를 갖는다
  constraint ordering_orders_confirmed_fields check (
    (status = 'DRAFT' and display_number is null and total_krw is null)
    or (status = 'CONFIRMED' and display_number is not null and total_krw is not null)
  )
);
create unique index ordering_orders_display_number_uq
  on public.ordering_orders (tenant_id, display_number)
  where display_number is not null;

create table public.ordering_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  position int not null check (position >= 1),
  book_key text not null check (btrim(book_key) <> ''),
  quantity int not null check (quantity >= 0),
  unit_price_krw bigint not null check (unit_price_krw >= 0),
  -- 주문 시점 도서 스냅샷 (BOOK-007)
  book_title text,
  book_isbn text,
  list_price_krw bigint check (list_price_krw is null or list_price_krw >= 0),
  unique (tenant_id, id),
  unique (order_id, position),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id)
);

-- 주문 갱신 규칙: version은 정확히 1씩 오르고(낙관적 잠금을 DB가 강제), 확정은 초안으로 돌아가지 않으며 소속은 바뀌지 않는다.
create function private.guard_order_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.tenant_id <> old.tenant_id then
    raise exception 'order id and tenant cannot change' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'order version must increase by exactly one' using errcode = 'P0001';
  end if;
  if old.status = 'CONFIRMED' and new.status <> 'CONFIRMED' then
    raise exception 'a confirmed order cannot return to draft' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_orders_guard_update
  before update on public.ordering_orders
  for each row execute function private.guard_order_update();

-- 품목 추가는 초안 주문에만, 수량은 1 이상. 부모 행을 공유 잠금해 동시 확정과 경쟁해도 확정 뒤 추가되지 않는다.
create function private.guard_order_line_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_status text;
begin
  select status into parent_status from public.ordering_orders
   where tenant_id = new.tenant_id and id = new.order_id
     for share;
  -- 부모가 없으면(다른 서점의 주문을 가리키는 등) 복합 FK가 거부하도록 맡긴다
  if not found then
    return new;
  end if;
  if parent_status <> 'DRAFT' then
    raise exception 'lines can only be added to a draft order' using errcode = 'P0001';
  end if;
  -- 음수는 CHECK가 거부하고, 0은 취소로만 생기므로 새 품목에서는 막는다
  if new.quantity = 0 then
    raise exception 'a new line needs a quantity of at least one' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_order_lines_guard_insert
  before insert on public.ordering_order_lines
  for each row execute function private.guard_order_line_insert();

-- 품목 변경은 수량 감소(취소 적용)만 허용한다. 도서·단가·스냅샷·소속은 불변이다.
create function private.guard_order_line_update() returns trigger
language plpgsql
set search_path = ''
as $$
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
  return new;
end;
$$;
create trigger ordering_order_lines_guard_update
  before update on public.ordering_order_lines
  for each row execute function private.guard_order_line_update();

-- 권한·RLS: 클라이언트는 같은 서점의 주문만 조회, 쓰기는 서버 경로(service_role)만. 주문은 삭제하지 않는다.
alter table public.ordering_orders enable row level security;
alter table public.ordering_order_lines enable row level security;
revoke all on public.ordering_orders, public.ordering_order_lines from public, anon, authenticated;
grant select on public.ordering_orders, public.ordering_order_lines to authenticated;
grant select, insert, update on public.ordering_orders, public.ordering_order_lines to service_role;

create policy ordering_orders_select on public.ordering_orders
  for select to authenticated
  using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

create policy ordering_order_lines_select on public.ordering_order_lines
  for select to authenticated
  using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
