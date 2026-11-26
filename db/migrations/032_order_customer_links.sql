-- 032 주문-고객 연결(고객 결정 #4): 고객은 주문에 선택으로 연결한다(기존 주문 호환). 연결은 추가 전용이고 주문의 현재 고객은 가장 최근 연결이다.
-- 같은 서점의 주문과 고객만 연결한다(복합 FK).
alter table public.ordering_customers add constraint ordering_customers_tenant_id_uq unique (tenant_id, id);

create table public.ordering_order_customer_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  customer_id uuid not null,
  linked_by text not null check (btrim(linked_by) <> ''),
  linked_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.ordering_customers (tenant_id, id)
);
create index ordering_order_customer_links_order_idx on public.ordering_order_customer_links (tenant_id, order_id, recorded_at);
create trigger ordering_order_customer_links_append_only before update or delete on public.ordering_order_customer_links
  for each row execute function private.forbid_mutation();

alter table public.ordering_order_customer_links enable row level security;
revoke all on public.ordering_order_customer_links from public, anon, authenticated;
grant select on public.ordering_order_customer_links to authenticated;
grant select, insert on public.ordering_order_customer_links to service_role;
create policy ordering_order_customer_links_select on public.ordering_order_customer_links
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
