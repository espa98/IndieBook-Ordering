-- 019 재고 운영: 초기 재고 등록·재고 조정 방어와 재고 조정 위임
-- 1) 초기 재고가 도서당 하나라는 규칙(BR-Q22)은 어댑터가 책 락 아래에서 지킨다. 기존 시험 픽스처가 같은 도서에 INITIAL 항목을 SQL로 여러 번 넣으므로 DB 유일 인덱스는 두지 않는다.
-- 2) 재고 조정은 초기 재고가 등록된 도서에만, 감소는 보유가 예약 아래로 내려가지 않게(BR-Q09). 책 락('<서점>:<책>')을 예약 가드와 같은 키로 잡는다.
-- 3) 재고 조정 위임: 점주가 위임한 직원만 조정할 수 있다(DEC-19). 위임을 주고 거두는 명령은 아직 없어 읽기 스키마만 둔다(승인 항목 I21).

create function private.guard_stock_adjust_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  on_hand bigint;
  reserved bigint;
begin
  if new.kind <> 'ADJUST' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':' || new.book_key, 0));
  if not exists (select 1 from public.ordering_stock_movements where tenant_id = new.tenant_id and book_key = new.book_key and kind = 'INITIAL') then
    raise exception 'initial stock must be registered before adjusting' using errcode = 'P0001';
  end if;
  if new.direction = 'OUT' then
    select coalesce(sum(case direction when 'IN' then quantity else -quantity end), 0) into on_hand
      from public.ordering_stock_movements where tenant_id = new.tenant_id and book_key = new.book_key;
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
    if on_hand - new.quantity < reserved then
      raise exception 'stock on hand must not go below the reserved quantity' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger ordering_stock_movements_guard_adjust before insert on public.ordering_stock_movements
  for each row execute function private.guard_stock_adjust_insert();

create table public.ordering_stock_delegations (
  tenant_id uuid not null references public.ordering_tenants (id),
  user_id uuid not null,
  delegated_by text not null check (btrim(delegated_by) <> ''),
  delegated_at timestamptz not null,
  primary key (tenant_id, user_id)
);
alter table public.ordering_stock_delegations enable row level security;
revoke all on public.ordering_stock_delegations from public, anon, authenticated;
grant select on public.ordering_stock_delegations to authenticated, service_role;
create policy ordering_stock_delegations_select on public.ordering_stock_delegations for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
