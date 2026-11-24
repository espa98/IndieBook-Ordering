-- 022 안내 문구 템플릿 버전 (ST-B05)
-- 템플릿은 (서점, 키)별로 버전이 1부터 하나씩 오르는 추가 전용 기록이다. 이전 버전은 바뀌지 않는다.
-- 락: 'tpl:<서점>:<키>' 어드바이저리 락(같은 템플릿의 동시 게시 직렬화).

create table public.ordering_template_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  key text not null check (key ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  version bigint not null check (version >= 1),
  body text not null check (btrim(body) <> '' and char_length(body) <= 1000),
  variables text[] not null default '{}',
  published_by text not null check (btrim(published_by) <> ''),
  published_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, key, version),
  unique (tenant_id, id)
);

create trigger ordering_template_versions_append_only before update or delete on public.ordering_template_versions
  for each row execute function private.forbid_mutation();

-- 버전은 현재 최신 + 1이어야 한다(건너뛰기 금지). 같은 버전의 재삽입은 유일 제약이 막는다.
create function private.guard_template_version_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  latest bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('tpl:' || new.tenant_id::text || ':' || new.key, 0));
  select coalesce(max(version), 0) into latest from public.ordering_template_versions where tenant_id = new.tenant_id and key = new.key;
  if new.version > latest + 1 then
    raise exception 'template versions must increase by one' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_template_versions_guard_insert before insert on public.ordering_template_versions
  for each row execute function private.guard_template_version_insert();

alter table public.ordering_template_versions enable row level security;
revoke all on public.ordering_template_versions from public, anon, authenticated;
grant select on public.ordering_template_versions to authenticated;
grant select, insert on public.ordering_template_versions to service_role;
create policy ordering_template_versions_select on public.ordering_template_versions
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
