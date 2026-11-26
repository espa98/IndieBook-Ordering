-- 031 고객(C-01~04) 1차: 최소 수집(이름 또는 별칭 + 국내 전화번호). 이메일·메모·마케팅 동의는 저장하지 않는다(고객 결정 #1, #7).
-- 번호는 서버가 정규화한 값(숫자만, 0으로 시작 9~11자리)만 받는다. 익명화된 고객은 번호가 없다(#2).
create table public.ordering_customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  name text not null check (btrim(name) <> ''),
  phone text check (phone ~ '^0[0-9]{8,10}$'),
  version int not null default 1 check (version >= 1),
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  check ((anonymized_at is null) = (phone is not null))
);
create index ordering_customers_phone_idx on public.ordering_customers (tenant_id, phone);

-- 고객 변경 이력(추가 전용, #8): 변경 전·후 값을 담는다. 직원에게는 서버가 변경 사실·시각만 보여 주고 전체 값은 Owner만 읽는다.
create table public.ordering_customer_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  customer_id uuid not null references public.ordering_customers (id),
  kind text not null check (kind in ('REGISTERED', 'UPDATED', 'ANONYMIZED')),
  before jsonb,
  after jsonb not null,
  "by" text not null check (btrim("by") <> ''),
  "at" timestamptz not null,
  recorded_at timestamptz not null default now()
);
create index ordering_customer_changes_customer_idx on public.ordering_customer_changes (customer_id, recorded_at);
create trigger ordering_customer_changes_append_only before update or delete on public.ordering_customer_changes
  for each row execute function private.forbid_mutation();

alter table public.ordering_customers enable row level security;
alter table public.ordering_customer_changes enable row level security;
revoke all on public.ordering_customers, public.ordering_customer_changes from public, anon, authenticated;
grant select on public.ordering_customers, public.ordering_customer_changes to authenticated;
grant select, insert, update on public.ordering_customers to service_role;
grant select, insert on public.ordering_customer_changes to service_role;
create policy ordering_customers_select on public.ordering_customers for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_customer_changes_select on public.ordering_customer_changes for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER']));
