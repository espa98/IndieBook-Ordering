-- 003 도서 카탈로그·멱등 명령 기록·표시번호 카운터
-- 멱등 기록(ordering_commands)과 카운터는 서버 전용이다(RLS-09): 클라이언트 역할에는 권한을 주지 않는다.

-- 서점별 도서 (ST-B01~B03). 주문 품목은 도서 정보를 스냅샷으로 복사하므로 주문에서 FK로 묶지 않는다.
create table public.ordering_books (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  title text not null check (btrim(title) <> ''),
  authors text[] not null default '{}',
  -- 숫자만 남긴 ISBN-10/13. 같은 ISBN의 도서는 중복 후보로 거부하되(도메인) 확인하면 별도 도서가 될 수 있어 유일 제약은 두지 않는다
  isbn text check (isbn is null or isbn ~ '^([0-9]{13}|[0-9]{9}[0-9X])$'),
  list_price_krw bigint not null check (list_price_krw >= 1),
  source text not null check (source in ('YES24', 'MANUAL')),
  external_id text,
  fetched_at timestamptz,
  manual_reason text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE')),
  version bigint not null default 1 check (version >= 1),
  created_by text not null,
  created_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  constraint ordering_books_source_fields check (
    (source = 'YES24' and external_id is not null and fetched_at is not null and manual_reason is null)
    or (source = 'MANUAL' and manual_reason is not null and external_id is null)
  )
);
create index ordering_books_isbn_idx on public.ordering_books (tenant_id, isbn) where isbn is not null;

-- 멱등 명령 기록. 같은 (서점, 작업, 키)는 한 번만 저장된다. 동시에 같은 키가 들어오면 유일 제약이 한쪽을 거부한다.
create table public.ordering_commands (
  tenant_id uuid not null references public.ordering_tenants (id),
  operation text not null,
  command_key text not null check (btrim(command_key) <> ''),
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, operation, command_key)
);

-- 서점별 주문 표시번호 카운터. 확정 때 이 행을 잠가 번호를 순서대로 발급한다.
create table public.ordering_counters (
  tenant_id uuid primary key references public.ordering_tenants (id),
  order_number bigint not null default 0 check (order_number >= 0)
);

alter table public.ordering_books enable row level security;
alter table public.ordering_commands enable row level security;
alter table public.ordering_counters enable row level security;
revoke all on public.ordering_books, public.ordering_commands, public.ordering_counters from public, anon, authenticated;

grant select on public.ordering_books to authenticated;
grant select, insert, update on public.ordering_books to service_role;
grant select, insert on public.ordering_commands to service_role;
grant select, insert, update on public.ordering_counters to service_role;

create policy ordering_books_select on public.ordering_books
  for select to authenticated
  using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
