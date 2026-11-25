-- 024 감사 로그 (E6, T9)
-- 쓰기 명령이 성공하면 서버가 같은 트랜잭션에서 한 줄을 남긴다(명령이 롤백되면 감사 행도 함께 사라진다).
-- 행위자·서점·작업·멱등 키·요청 본문 해시·대상 식별자만 기록한다. 전·후 값은 도메인 원장(추가 전용)이 이미 갖고 있고,
-- 본문 원문은 개인정보·증빙·초대 토큰을 담을 수 있어 저장하지 않는다(해시만).
-- 추가 전용이다. 보존기간(D29)이 정해지지 않아 삭제 경로를 두지 않는다. 서점 Owner만 자기 서점의 기록을 읽는다.

create table public.ordering_audit_log (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  -- 서점을 만들기 전의 계정 업무(서점 개설·초대 수락)는 서점이 없다
  tenant_id uuid references public.ordering_tenants (id),
  actor_id uuid not null,
  operation text not null check (btrim(operation) <> ''),
  command_key text check (command_key is null or btrim(command_key) <> ''),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  targets jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now()
);
create index ordering_audit_log_tenant_idx on public.ordering_audit_log (tenant_id, seq);
create index ordering_audit_log_actor_idx on public.ordering_audit_log (actor_id, seq);

create trigger ordering_audit_log_append_only before update or delete on public.ordering_audit_log
  for each row execute function private.forbid_mutation();

alter table public.ordering_audit_log enable row level security;
revoke all on public.ordering_audit_log from public, anon, authenticated;
grant select on public.ordering_audit_log to authenticated;
grant select, insert on public.ordering_audit_log to service_role;
grant usage on sequence public.ordering_audit_log_seq_seq to service_role;
create policy ordering_audit_log_select on public.ordering_audit_log
  for select to authenticated
  using (tenant_id is not null and private.is_ordering_member(tenant_id, array['OWNER']));
