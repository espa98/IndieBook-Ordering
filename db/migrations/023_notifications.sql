-- 023 고객 안내 (ST-M01~M06)
-- 안내 대상은 생성 시점의 확보량 스냅샷을 보존하고, 발송 시도·문구 복사·결과는 별도 추가 전용 기록이다(BR-M01).
-- 고객 연락처는 저장하지 않는다(DEC-12 법률 검토 전). 상태는 시도·결과 기록에서 파생한다.
-- 락: 같은 주문의 안내 쓰기는 'ntf:<서점>:<주문>' 어드바이저리 락으로 직렬화한다.

create table public.ordering_notification_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  mode text not null check (mode in ('FULL', 'PARTIAL')),
  renotice_of_target_id uuid,
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  secured_total int not null check (secured_total >= 0),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id),
  foreign key (tenant_id, renotice_of_target_id) references public.ordering_notification_targets (tenant_id, id)
);
create index ordering_notification_targets_order_idx on public.ordering_notification_targets (tenant_id, order_id);

create trigger ordering_notification_targets_append_only before update or delete on public.ordering_notification_targets
  for each row execute function private.forbid_mutation();

alter table public.ordering_notification_targets enable row level security;
revoke all on public.ordering_notification_targets from public, anon, authenticated;
grant select on public.ordering_notification_targets to authenticated;
grant select, insert on public.ordering_notification_targets to service_role;
create policy ordering_notification_targets_select on public.ordering_notification_targets
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

-- 문구 미리보기·복사·공유 기록(ST-M02): 발송 증빙이 아니며 상태를 바꾸지 않는다.
create table public.ordering_notification_copies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  target_id uuid not null,
  action text not null check (action in ('PREVIEW', 'COPY', 'SHARE')),
  acted_by text not null check (btrim(acted_by) <> ''),
  acted_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, target_id) references public.ordering_notification_targets (tenant_id, id)
);

-- 외부 발송 시도(ST-M03): 안내 대상당 한 번. 발송 당시 문구를 보존한다. 수신·읽음을 뜻하지 않는다.
create table public.ordering_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  target_id uuid not null,
  channel text not null check (channel in ('PHONE', 'SMS', 'MESSENGER', 'VISIT', 'OTHER')),
  message_snapshot text not null check (btrim(message_snapshot) <> ''),
  attempted_by text not null check (btrim(attempted_by) <> ''),
  attempted_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, target_id),
  foreign key (tenant_id, target_id) references public.ordering_notification_targets (tenant_id, id)
);

create trigger ordering_notification_copies_append_only before update or delete on public.ordering_notification_copies
  for each row execute function private.forbid_mutation();
create trigger ordering_notification_attempts_append_only before update or delete on public.ordering_notification_attempts
  for each row execute function private.forbid_mutation();

alter table public.ordering_notification_copies enable row level security;
alter table public.ordering_notification_attempts enable row level security;
revoke all on public.ordering_notification_copies, public.ordering_notification_attempts from public, anon, authenticated;
grant select on public.ordering_notification_copies, public.ordering_notification_attempts to authenticated;
grant select, insert on public.ordering_notification_copies, public.ordering_notification_attempts to service_role;
create policy ordering_notification_copies_select on public.ordering_notification_copies
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_notification_attempts_select on public.ordering_notification_attempts
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

-- 직원이 확인한 결과(ST-M04): 시도당 한 번. 고객의 수신·읽음은 저장하지 않는다(MSG-010).
create table public.ordering_notification_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  target_id uuid not null,
  attempt_id uuid not null,
  outcome text not null check (outcome in ('MANUAL_RECORDED', 'FAILED')),
  note text not null check (btrim(note) <> ''),
  recorded_by text not null check (btrim(recorded_by) <> ''),
  result_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, attempt_id),
  foreign key (tenant_id, attempt_id) references public.ordering_notification_attempts (tenant_id, id),
  foreign key (tenant_id, target_id) references public.ordering_notification_targets (tenant_id, id)
);
create trigger ordering_notification_results_append_only before update or delete on public.ordering_notification_results
  for each row execute function private.forbid_mutation();
alter table public.ordering_notification_results enable row level security;
revoke all on public.ordering_notification_results from public, anon, authenticated;
grant select on public.ordering_notification_results to authenticated;
grant select, insert on public.ordering_notification_results to service_role;
create policy ordering_notification_results_select on public.ordering_notification_results
  for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

-- 실패한 안내 대상은 한 번만 재안내할 수 있다(ST-M05).
create unique index ordering_notification_targets_renotice_uq on public.ordering_notification_targets (tenant_id, renotice_of_target_id) where renotice_of_target_id is not null;
