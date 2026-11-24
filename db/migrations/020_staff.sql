-- 020 직원 초대·철회·활성 전환
-- 초대 토큰은 SHA-256 해시만 저장한다(원문은 초대한 Owner에게 한 번 응답으로만 전달된다). 상태는 사건 기록과 만료 시각에서 파생한다(ST-A03/A04).
-- 초대·철회·변경 이력은 추가 전용이고, 초대와 변경 이력은 Owner만 읽는다.
-- 락: 같은 이메일의 중복 초대는 'inv:<서점>:<이메일>' 어드바이저리 락으로 직렬화한다.

create table public.ordering_staff_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  email text not null check (email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text not null check (role = 'STAFF'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by text not null check (btrim(invited_by) <> ''),
  invited_at timestamptz not null,
  expires_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (expires_at > invited_at),
  unique (tenant_id, id)
);
create index ordering_staff_invitations_email_idx on public.ordering_staff_invitations (tenant_id, email);

-- 초대당 종결 사건(수락 또는 철회)은 하나뿐이다.
create table public.ordering_invitation_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  invitation_id uuid not null,
  kind text not null check (kind in ('ACCEPTED', 'REVOKED')),
  actor_id text not null check (btrim(actor_id) <> ''),
  at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, invitation_id),
  foreign key (tenant_id, invitation_id) references public.ordering_staff_invitations (tenant_id, id)
);

create table public.ordering_membership_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  from_status text not null check (from_status in ('ACTIVE', 'INACTIVE')),
  to_status text not null check (to_status in ('ACTIVE', 'INACTIVE')),
  changed_by text not null check (btrim(changed_by) <> ''),
  changed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (from_status <> to_status),
  foreign key (tenant_id, user_id) references public.ordering_members (tenant_id, user_id)
);

create trigger ordering_staff_invitations_append_only before update or delete on public.ordering_staff_invitations
  for each row execute function private.forbid_mutation();
create trigger ordering_invitation_events_append_only before update or delete on public.ordering_invitation_events
  for each row execute function private.forbid_mutation();
create trigger ordering_membership_changes_append_only before update or delete on public.ordering_membership_changes
  for each row execute function private.forbid_mutation();

-- 같은 이메일에 아직 쓸 수 있는 초대(만료 전, 종결 사건 없음)가 있으면 새 초대를 넣을 수 없다.
create function private.guard_staff_invitation_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('inv:' || new.tenant_id::text || ':' || new.email, 0));
  if exists (
    select 1 from public.ordering_staff_invitations i
     where i.tenant_id = new.tenant_id and i.email = new.email and i.expires_at > now()
       and not exists (select 1 from public.ordering_invitation_events e where e.tenant_id = i.tenant_id and e.invitation_id = i.id)
  ) then
    raise exception 'an active invitation already exists for this email' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_staff_invitations_guard_insert before insert on public.ordering_staff_invitations
  for each row execute function private.guard_staff_invitation_insert();

alter table public.ordering_staff_invitations enable row level security;
alter table public.ordering_invitation_events enable row level security;
alter table public.ordering_membership_changes enable row level security;
revoke all on public.ordering_staff_invitations, public.ordering_invitation_events, public.ordering_membership_changes from public, anon, authenticated;
grant select on public.ordering_staff_invitations, public.ordering_invitation_events, public.ordering_membership_changes to authenticated;
grant select, insert on public.ordering_staff_invitations, public.ordering_invitation_events, public.ordering_membership_changes to service_role;
create policy ordering_staff_invitations_select on public.ordering_staff_invitations for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER']));
create policy ordering_invitation_events_select on public.ordering_invitation_events for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER']));
create policy ordering_membership_changes_select on public.ordering_membership_changes for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER']));
