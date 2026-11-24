-- 010 반품 후속 흐름: 공급처 회신·출고·완료·예외·예외 해소·재협의
-- 1) 회신·출고 테이블을 만들고, 008이 읽기 스키마로만 둔 완료·예외·해소에는 근거(evidence) 열을 더한다. 재협의 요청은 원 요청을 가리킨다.
-- 2) 같은 취소 물량의 모든 후속 기록은 취소 물량 단위 락('dsp:')으로 직렬화하고 수량 불변식을 DB가 막는다.
-- 3) 009의 처분 대기 방어는 이제 공급처 거절 수량을 처분 대기로 되돌려 센다(도메인과 같은 계산).

create table public.ordering_return_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  return_request_id uuid not null,
  accepted_quantity int not null check (accepted_quantity >= 0),
  rejected_quantity int not null check (rejected_quantity >= 0),
  evidence text not null check (btrim(evidence) <> ''),
  replied_by text not null check (btrim(replied_by) <> ''),
  replied_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (accepted_quantity + rejected_quantity >= 1),
  foreign key (tenant_id, return_request_id) references public.ordering_return_requests (tenant_id, id)
);
create table public.ordering_return_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  return_request_id uuid not null,
  quantity int not null check (quantity >= 1),
  dispatched_by text not null check (btrim(dispatched_by) <> ''),
  dispatched_at timestamptz not null,
  reference_number text check (reference_number is null or btrim(reference_number) <> ''),
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, return_request_id) references public.ordering_return_requests (tenant_id, id)
);

alter table public.ordering_return_completions add column evidence text not null default '';
alter table public.ordering_return_exceptions add column evidence text not null default '';
alter table public.ordering_return_exception_resolutions add column evidence text not null default '';
alter table public.ordering_return_completions alter column evidence drop default;
alter table public.ordering_return_exceptions alter column evidence drop default;
alter table public.ordering_return_exception_resolutions alter column evidence drop default;
alter table public.ordering_return_completions add check (btrim(evidence) <> '');
alter table public.ordering_return_exceptions add check (btrim(evidence) <> '');
alter table public.ordering_return_exception_resolutions add check (btrim(evidence) <> '');
alter table public.ordering_return_exceptions add check (kind in ('RETURNED_BACK', 'LOST', 'REFUSED'));

alter table public.ordering_return_requests add column retry_of_request_id uuid;
alter table public.ordering_return_requests add column retry_reason text;
alter table public.ordering_return_requests add foreign key (tenant_id, retry_of_request_id) references public.ordering_return_requests (tenant_id, id);
alter table public.ordering_return_requests add check ((retry_of_request_id is null) = (retry_reason is null));
alter table public.ordering_return_requests add check (retry_reason is null or btrim(retry_reason) <> '');

create trigger ordering_return_replies_append_only before update or delete on public.ordering_return_replies
  for each row execute function private.forbid_mutation();
create trigger ordering_return_dispatches_append_only before update or delete on public.ordering_return_dispatches
  for each row execute function private.forbid_mutation();
alter table public.ordering_return_replies enable row level security;
alter table public.ordering_return_dispatches enable row level security;
revoke all on public.ordering_return_replies, public.ordering_return_dispatches from public, anon, authenticated;
grant select on public.ordering_return_replies, public.ordering_return_dispatches to authenticated;
grant select, insert on public.ordering_return_replies, public.ordering_return_dispatches to service_role;
create policy ordering_return_replies_select on public.ordering_return_replies for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
create policy ordering_return_dispatches_select on public.ordering_return_dispatches for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

-- 처분 대기 방어(009 교체): 재고 편입 + 반품 요청 - 공급처 거절 - 회수 확인된 예외 수량이 취소 수량을 넘을 수 없다.
-- 재협의 요청은 원 요청에서 거절된 수량 중 아직 재협의하지 않은 만큼만 가능하다.
create or replace function private.guard_cancellation_disposition_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cancelled int;
  intaken bigint;
  held bigint;
  rejected bigint;
  recovered bigint;
  original_rejected bigint;
  retried bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('dsp:' || new.tenant_id::text || ':' || new.cancellation_id::text, 0));
  select quantity into cancelled from public.ordering_allocation_cancellations
   where tenant_id = new.tenant_id and id = new.cancellation_id;
  select coalesce(sum(quantity), 0) into intaken from public.ordering_stock_intakes
   where tenant_id = new.tenant_id and cancellation_id = new.cancellation_id;
  select coalesce(sum(quantity), 0) into held from public.ordering_return_requests
   where tenant_id = new.tenant_id and cancellation_id = new.cancellation_id;
  select coalesce(sum(p.rejected_quantity), 0) into rejected from public.ordering_return_replies p
    join public.ordering_return_requests q on q.tenant_id = p.tenant_id and q.id = p.return_request_id
   where p.tenant_id = new.tenant_id and q.cancellation_id = new.cancellation_id;
  select coalesce(sum(r.quantity), 0) into recovered from public.ordering_return_exception_resolutions r
    join public.ordering_return_exceptions e on e.tenant_id = r.tenant_id and e.id = r.return_exception_id
    join public.ordering_return_requests q on q.tenant_id = e.tenant_id and q.id = e.return_request_id
   where r.tenant_id = new.tenant_id and q.cancellation_id = new.cancellation_id and r.outcome = 'RECOVERED';
  if intaken + held - rejected - recovered + new.quantity > cancelled then
    raise exception 'the disposition exceeds the pending quantity of the cancellation' using errcode = 'P0001';
  end if;
  if tg_table_name = 'ordering_return_requests' then
    if new.retry_of_request_id is not null then
      select coalesce(sum(rejected_quantity), 0) into original_rejected from public.ordering_return_replies
       where tenant_id = new.tenant_id and return_request_id = new.retry_of_request_id;
      select coalesce(sum(quantity), 0) into retried from public.ordering_return_requests
       where tenant_id = new.tenant_id and retry_of_request_id = new.retry_of_request_id;
      if retried + new.quantity > original_rejected then
        raise exception 'the renegotiated quantity exceeds the rejected quantity of the original request' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- 반품 후속 기록의 수량 불변식. 요청에서 취소 물량을 찾아 같은 'dsp:' 락을 잡는다.
create function private.guard_return_flow_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  request_id uuid;
  cancellation uuid;
  request_quantity int;
  replied bigint;
  accepted bigint;
  dispatched bigint;
  completed bigint;
  excepted bigint;
  exception_quantity int;
  resolved bigint;
begin
  if tg_table_name = 'ordering_return_exception_resolutions' then
    select return_request_id, quantity into request_id, exception_quantity from public.ordering_return_exceptions
     where tenant_id = new.tenant_id and id = new.return_exception_id;
  else
    request_id := new.return_request_id;
  end if;
  select cancellation_id, quantity into cancellation, request_quantity from public.ordering_return_requests
   where tenant_id = new.tenant_id and id = request_id;
  perform pg_advisory_xact_lock(hashtextextended('dsp:' || new.tenant_id::text || ':' || cancellation::text, 0));

  select coalesce(sum(accepted_quantity + rejected_quantity), 0), coalesce(sum(accepted_quantity), 0) into replied, accepted
    from public.ordering_return_replies where tenant_id = new.tenant_id and return_request_id = request_id;
  select coalesce(sum(quantity), 0) into dispatched from public.ordering_return_dispatches where tenant_id = new.tenant_id and return_request_id = request_id;
  select coalesce(sum(quantity), 0) into completed from public.ordering_return_completions where tenant_id = new.tenant_id and return_request_id = request_id;
  select coalesce(sum(quantity), 0) into excepted from public.ordering_return_exceptions where tenant_id = new.tenant_id and return_request_id = request_id;

  if tg_table_name = 'ordering_return_replies' then
    if replied + new.accepted_quantity + new.rejected_quantity > request_quantity then
      raise exception 'the replied quantity exceeds the return request quantity' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'ordering_return_dispatches' then
    if dispatched + new.quantity > accepted then
      raise exception 'the dispatched quantity exceeds the accepted quantity' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'ordering_return_completions' or tg_table_name = 'ordering_return_exceptions' then
    if completed + excepted + new.quantity > dispatched then
      raise exception 'the completed and excepted quantity exceeds the dispatched quantity' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'ordering_return_exception_resolutions' then
    select coalesce(sum(quantity), 0) into resolved from public.ordering_return_exception_resolutions
     where tenant_id = new.tenant_id and return_exception_id = new.return_exception_id;
    if resolved + new.quantity > exception_quantity then
      raise exception 'the resolved quantity exceeds the exception quantity' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger ordering_return_replies_guard_flow before insert on public.ordering_return_replies
  for each row execute function private.guard_return_flow_insert();
create trigger ordering_return_dispatches_guard_flow before insert on public.ordering_return_dispatches
  for each row execute function private.guard_return_flow_insert();
create trigger ordering_return_completions_guard_flow before insert on public.ordering_return_completions
  for each row execute function private.guard_return_flow_insert();
create trigger ordering_return_exceptions_guard_flow before insert on public.ordering_return_exceptions
  for each row execute function private.guard_return_flow_insert();
create trigger ordering_return_exception_resolutions_guard_flow before insert on public.ordering_return_exception_resolutions
  for each row execute function private.guard_return_flow_insert();
