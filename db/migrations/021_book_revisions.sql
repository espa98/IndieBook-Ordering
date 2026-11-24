-- 021 도서 수정 이력 (ST-B03)
-- 수정 전·후 값을 추가 전용으로 보존한다. 주문 품목은 단가 스냅샷을 따로 가지므로 기존 주문은 영향을 받지 않는다.
-- 락: 같은 서점의 도서 등록·수정은 'books:<서점>' 어드바이저리 락으로 직렬화한다.

create table public.ordering_book_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  book_id uuid not null,
  version_before bigint not null check (version_before >= 1),
  version_after bigint not null,
  before jsonb not null,
  after jsonb not null,
  reason text not null check (btrim(reason) <> ''),
  changed_by text not null check (btrim(changed_by) <> ''),
  changed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (version_after = version_before + 1),
  unique (tenant_id, book_id, version_after),
  foreign key (tenant_id, book_id) references public.ordering_books (tenant_id, id)
);

create trigger ordering_book_revisions_append_only before update or delete on public.ordering_book_revisions
  for each row execute function private.forbid_mutation();

alter table public.ordering_book_revisions enable row level security;
revoke all on public.ordering_book_revisions from public, anon, authenticated;
grant select on public.ordering_book_revisions to authenticated;
grant select, insert on public.ordering_book_revisions to service_role;
create policy ordering_book_revisions_select on public.ordering_book_revisions
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
