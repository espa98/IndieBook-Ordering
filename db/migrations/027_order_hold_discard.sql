-- 027 초안 보류·재개(ST-O02)와 폐기(ST-O09). 상태 값은 늘리지 않고(DRAFT·CONFIRMED 유지) 시각·사유·담당자 필드로 표현한다.
-- 보류는 재개하면 지워지고, 폐기는 되돌릴 수 없다. 둘 다 초안에만 있을 수 있고 동시에 가질 수 없다.
alter table public.ordering_orders
  add column held_at timestamptz,
  add column hold_reason text,
  add column held_by text,
  add column discarded_at timestamptz,
  add column discard_reason text,
  add column discarded_by text;

alter table public.ordering_orders
  add constraint ordering_orders_hold_fields check (
    (held_at is null and hold_reason is null and held_by is null)
    or (held_at is not null and btrim(hold_reason) <> '' and held_by is not null)
  ),
  add constraint ordering_orders_discard_fields check (
    (discarded_at is null and discard_reason is null and discarded_by is null)
    or (discarded_at is not null and btrim(discard_reason) <> '' and discarded_by is not null)
  ),
  add constraint ordering_orders_hold_discard_draft_only check (
    status = 'DRAFT' or (held_at is null and discarded_at is null)
  ),
  add constraint ordering_orders_not_held_and_discarded check (held_at is null or discarded_at is null);

-- 폐기한 주문은 어떤 갱신도 거부한다(이력 보존, 되돌릴 수 없음)
create or replace function private.guard_order_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.tenant_id <> old.tenant_id then
    raise exception 'order id and tenant cannot change' using errcode = 'P0001';
  end if;
  if old.discarded_at is not null then
    raise exception 'a discarded order cannot change' using errcode = 'P0001';
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
