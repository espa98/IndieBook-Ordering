-- 028 주문 보류·재개·폐기 이력(추가 전용 원장). 재개하면 주문의 보류 필드는 지워지므로(027) 사유를 여기에 남긴다.
-- 쓰기는 서버(service_role)가 명령과 같은 트랜잭션에서, 읽기는 같은 서점의 활성 멤버만(RLS).
create table public.ordering_order_events (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  tenant_id uuid not null,
  order_id uuid not null,
  kind text not null check (kind in ('HOLD', 'RESUME', 'DISCARD')),
  reason text,
  actor_id text not null check (btrim(actor_id) <> ''),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id),
  -- 보류·폐기는 사유가 필수이고 재개는 사유가 없다
  check ((kind = 'RESUME' and reason is null) or (kind <> 'RESUME' and reason is not null and btrim(reason) <> ''))
);
create index ordering_order_events_order_idx on public.ordering_order_events (tenant_id, order_id, seq);
create trigger ordering_order_events_append_only
  before update or delete on public.ordering_order_events
  for each row execute function private.forbid_mutation();

alter table public.ordering_order_events enable row level security;
revoke all on public.ordering_order_events from public, anon, authenticated;
grant select on public.ordering_order_events to authenticated;
grant select, insert on public.ordering_order_events to service_role;
create policy ordering_order_events_select on public.ordering_order_events
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
