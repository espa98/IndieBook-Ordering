-- 005 결제·환급 원장
-- 모든 기록은 추가 전용이다. 결제 상태·환급 업무 진행·요청 상태는 저장하지 않고 기록에서 파생한다(BR-Y07).
-- 환급 한도·요청당 1회 결정·유일 외부 거래는 DB가 끝까지 강제한다. 주문 단위 어드바이저리 락
-- ('pay:<서점>:<주문>')을 어댑터와 트리거가 같이 잡아 어댑터를 거치지 않는 쓰기도 직렬화한다.
-- 결제·증빙은 민감 정보라(RLS-03) 클라이언트 역할에는 어떤 권한도 주지 않는다. 읽기는 서버가 도메인 권한을 거쳐 제공한다.
-- 트리거 함수는 호출자(service_role) 권한으로 실행되므로 private 스키마의 다른 함수를 부르지 않고 락을 직접 잡는다.

create table public.ordering_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ordering_tenants (id),
  order_id uuid not null,
  method text not null check (method in ('CARD', 'EASY_PAY', 'BANK_TRANSFER')),
  amount_krw bigint not null check (amount_krw >= 1),
  external_reference text not null check (btrim(external_reference) <> ''),
  paid_at timestamptz not null,
  recorded_by text not null check (btrim(recorded_by) <> ''),
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  -- 같은 외부 거래를 두 번 기록하면 매출·환급이 이중으로 잡힌다 (DEC-14)
  unique (tenant_id, method, external_reference),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id)
);
create index ordering_payments_order_idx on public.ordering_payments (tenant_id, order_id);

create table public.ordering_payment_confirmations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  payment_id uuid not null,
  evidence text not null check (btrim(evidence) <> ''),
  confirmed_by text not null check (btrim(confirmed_by) <> ''),
  confirmed_at timestamptz not null,
  verification_source text not null default 'STAFF_MANUAL_EVIDENCE' check (verification_source = 'STAFF_MANUAL_EVIDENCE'),
  recorded_at timestamptz not null default now(),
  unique (tenant_id, payment_id),
  foreign key (tenant_id, payment_id) references public.ordering_payments (tenant_id, id)
);

create table public.ordering_payment_voids (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  payment_id uuid not null,
  reason text not null check (btrim(reason) <> ''),
  voided_by text not null check (btrim(voided_by) <> ''),
  voided_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, payment_id),
  foreign key (tenant_id, payment_id) references public.ordering_payments (tenant_id, id)
);

create table public.ordering_payment_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  payment_id uuid not null,
  reduced_krw bigint not null check (reduced_krw >= 1),
  reason text not null check (btrim(reason) <> ''),
  evidence text not null check (btrim(evidence) <> ''),
  corrected_by text not null check (btrim(corrected_by) <> ''),
  corrected_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id),
  foreign key (tenant_id, payment_id) references public.ordering_payments (tenant_id, id)
);

create table public.ordering_refund_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  required_krw bigint not null check (required_krw >= 1),
  opened_by text not null check (btrim(opened_by) <> ''),
  opened_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id)
);

create table public.ordering_refund_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  refund_task_id uuid not null,
  order_id uuid not null,
  payment_id uuid not null,
  amount_krw bigint not null check (amount_krw >= 1),
  evidence text not null check (btrim(evidence) <> ''),
  requested_by text not null check (btrim(requested_by) <> ''),
  requested_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, refund_task_id) references public.ordering_refund_tasks (tenant_id, id),
  foreign key (tenant_id, payment_id) references public.ordering_payments (tenant_id, id)
);

-- 요청당 결정은 한 번이다. 두 세션이 같은 요청을 승인·거절해도 한쪽은 유일 제약에 걸린다.
create table public.ordering_refund_request_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  request_id uuid not null,
  kind text not null check (kind in ('APPROVED', 'REJECTED', 'WITHDRAWN')),
  decided_by text not null check (btrim(decided_by) <> ''),
  decided_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, request_id),
  foreign key (tenant_id, request_id) references public.ordering_refund_requests (tenant_id, id)
);

-- 환급 원장. 요청 하나는 원장 한 줄만 만든다.
create table public.ordering_refund_confirmations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  refund_task_id uuid not null,
  order_id uuid not null,
  payment_id uuid not null,
  amount_krw bigint not null check (amount_krw >= 1),
  evidence text not null check (btrim(evidence) <> ''),
  confirmed_by text not null check (btrim(confirmed_by) <> ''),
  confirmed_at timestamptz not null,
  refund_request_id uuid,
  verification_source text not null default 'STAFF_MANUAL_EVIDENCE' check (verification_source = 'STAFF_MANUAL_EVIDENCE'),
  recorded_at timestamptz not null default now(),
  unique (tenant_id, refund_request_id),
  foreign key (tenant_id, refund_task_id) references public.ordering_refund_tasks (tenant_id, id),
  foreign key (tenant_id, payment_id) references public.ordering_payments (tenant_id, id),
  foreign key (tenant_id, refund_request_id) references public.ordering_refund_requests (tenant_id, id)
);
create index ordering_refund_confirmations_task_idx on public.ordering_refund_confirmations (tenant_id, refund_task_id);
create index ordering_refund_confirmations_payment_idx on public.ordering_refund_confirmations (tenant_id, payment_id);

-- 환급 시도의 실패·불명확 결과(ST-Y07). 미해소 UNKNOWN은 한도를 예약한다.
create table public.ordering_refund_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  refund_task_id uuid not null,
  order_id uuid not null,
  payment_id uuid not null,
  amount_krw bigint not null check (amount_krw >= 1),
  result text not null check (result in ('FAILED', 'UNKNOWN')),
  reason text not null check (btrim(reason) <> ''),
  reported_by text not null check (btrim(reported_by) <> ''),
  reported_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, refund_task_id) references public.ordering_refund_tasks (tenant_id, id),
  foreign key (tenant_id, payment_id) references public.ordering_payments (tenant_id, id)
);
create table public.ordering_refund_attempt_resolutions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  attempt_id uuid not null,
  outcome text not null check (outcome in ('FAILED', 'CONFIRMED')),
  evidence text not null check (btrim(evidence) <> ''),
  resolved_by text not null check (btrim(resolved_by) <> ''),
  resolved_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, attempt_id),
  foreign key (tenant_id, attempt_id) references public.ordering_refund_attempts (tenant_id, id)
);

-- 추가 전용
create trigger ordering_payments_append_only before update or delete on public.ordering_payments
  for each row execute function private.forbid_mutation();
create trigger ordering_payment_confirmations_append_only before update or delete on public.ordering_payment_confirmations
  for each row execute function private.forbid_mutation();
create trigger ordering_payment_voids_append_only before update or delete on public.ordering_payment_voids
  for each row execute function private.forbid_mutation();
create trigger ordering_payment_corrections_append_only before update or delete on public.ordering_payment_corrections
  for each row execute function private.forbid_mutation();
create trigger ordering_refund_tasks_append_only before update or delete on public.ordering_refund_tasks
  for each row execute function private.forbid_mutation();
create trigger ordering_refund_requests_append_only before update or delete on public.ordering_refund_requests
  for each row execute function private.forbid_mutation();
create trigger ordering_refund_request_decisions_append_only before update or delete on public.ordering_refund_request_decisions
  for each row execute function private.forbid_mutation();
create trigger ordering_refund_confirmations_append_only before update or delete on public.ordering_refund_confirmations
  for each row execute function private.forbid_mutation();
create trigger ordering_refund_attempts_append_only before update or delete on public.ordering_refund_attempts
  for each row execute function private.forbid_mutation();
create trigger ordering_refund_attempt_resolutions_append_only before update or delete on public.ordering_refund_attempt_resolutions
  for each row execute function private.forbid_mutation();

-- 확인과 무효는 서로 배타적이다: 확인된 결제는 무효로, 무효된 결제는 확인으로 만들 수 없다.
create function private.guard_payment_confirmation_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  pay_order uuid;
begin
  select order_id into pay_order from public.ordering_payments where tenant_id = new.tenant_id and id = new.payment_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('pay:' || new.tenant_id::text || ':' || pay_order::text, 0));
  if exists (select 1 from public.ordering_payment_voids where tenant_id = new.tenant_id and payment_id = new.payment_id) then
    raise exception 'a voided payment cannot be confirmed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_payment_confirmations_guard_insert before insert on public.ordering_payment_confirmations
  for each row execute function private.guard_payment_confirmation_insert();

create function private.guard_payment_void_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  pay_order uuid;
begin
  select order_id into pay_order from public.ordering_payments where tenant_id = new.tenant_id and id = new.payment_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('pay:' || new.tenant_id::text || ':' || pay_order::text, 0));
  if exists (select 1 from public.ordering_payment_confirmations where tenant_id = new.tenant_id and payment_id = new.payment_id) then
    raise exception 'a confirmed payment cannot be voided' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_payment_voids_guard_insert before insert on public.ordering_payment_voids
  for each row execute function private.guard_payment_void_insert();

-- 환급 업무: 주문당 활성(남은 필요액 > 0) 업무는 하나다.
create function private.guard_refund_task_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('pay:' || new.tenant_id::text || ':' || new.order_id::text, 0));
  if exists (
    select 1 from public.ordering_refund_tasks t
     where t.tenant_id = new.tenant_id and t.order_id = new.order_id
       and t.required_krw > coalesce((select sum(c.amount_krw) from public.ordering_refund_confirmations c
                                       where c.tenant_id = t.tenant_id and c.refund_task_id = t.id), 0)
  ) then
    raise exception 'a refund task is already open for this order' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_refund_tasks_guard_insert before insert on public.ordering_refund_tasks
  for each row execute function private.guard_refund_task_insert();

-- 환급 요청 한도(BR-Y08): 업무 남은 필요액과 원 결제 가용액에서 확정 환급·진행 중 요청·미해소 UNKNOWN 시도를 뺀다.
create function private.guard_refund_request_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  task_order uuid;
  task_required bigint;
  pay_order uuid;
  pay_amount bigint;
  task_remaining bigint;
  pay_available bigint;
begin
  select order_id, required_krw into task_order, task_required
    from public.ordering_refund_tasks where tenant_id = new.tenant_id and id = new.refund_task_id;
  if not found then return new; end if;
  select order_id, amount_krw into pay_order, pay_amount
    from public.ordering_payments where tenant_id = new.tenant_id and id = new.payment_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('pay:' || new.tenant_id::text || ':' || task_order::text, 0));
  if task_order <> new.order_id or pay_order <> new.order_id then
    raise exception 'the refund task, payment and request must belong to the same order' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.ordering_payment_confirmations where tenant_id = new.tenant_id and payment_id = new.payment_id)
     or exists (select 1 from public.ordering_payment_voids where tenant_id = new.tenant_id and payment_id = new.payment_id) then
    raise exception 'the refunded payment must be a confirmed, non-voided payment of this order' using errcode = 'P0001';
  end if;

  task_remaining := task_required
    - coalesce((select sum(amount_krw) from public.ordering_refund_confirmations
                 where tenant_id = new.tenant_id and refund_task_id = new.refund_task_id), 0)
    - coalesce((select sum(r.amount_krw) from public.ordering_refund_requests r
                 where r.tenant_id = new.tenant_id and r.refund_task_id = new.refund_task_id
                   and not exists (select 1 from public.ordering_refund_request_decisions d
                                    where d.tenant_id = r.tenant_id and d.request_id = r.id)), 0)
    - coalesce((select sum(a.amount_krw) from public.ordering_refund_attempts a
                 where a.tenant_id = new.tenant_id and a.refund_task_id = new.refund_task_id and a.result = 'UNKNOWN'
                   and not exists (select 1 from public.ordering_refund_attempt_resolutions x
                                    where x.tenant_id = a.tenant_id and x.attempt_id = a.id)), 0);
  pay_available := pay_amount
    - coalesce((select sum(reduced_krw) from public.ordering_payment_corrections
                 where tenant_id = new.tenant_id and payment_id = new.payment_id), 0)
    - coalesce((select sum(amount_krw) from public.ordering_refund_confirmations
                 where tenant_id = new.tenant_id and payment_id = new.payment_id), 0)
    - coalesce((select sum(r.amount_krw) from public.ordering_refund_requests r
                 where r.tenant_id = new.tenant_id and r.payment_id = new.payment_id
                   and not exists (select 1 from public.ordering_refund_request_decisions d
                                    where d.tenant_id = r.tenant_id and d.request_id = r.id)), 0)
    - coalesce((select sum(a.amount_krw) from public.ordering_refund_attempts a
                 where a.tenant_id = new.tenant_id and a.payment_id = new.payment_id and a.result = 'UNKNOWN'
                   and not exists (select 1 from public.ordering_refund_attempt_resolutions x
                                    where x.tenant_id = a.tenant_id and x.attempt_id = a.id)), 0);
  if new.amount_krw > task_remaining or new.amount_krw > pay_available then
    raise exception 'refund request must not exceed the task or payment remaining amount including pending requests' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_refund_requests_guard_insert before insert on public.ordering_refund_requests
  for each row execute function private.guard_refund_request_insert();

-- 환급 원장 한도: 업무 필요액과 원 결제 가용액(결제액 - 보정 - 기환급)을 넘지 않는다.
create function private.guard_refund_confirmation_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  task_order uuid;
  task_required bigint;
  pay_order uuid;
  pay_amount bigint;
begin
  select order_id, required_krw into task_order, task_required
    from public.ordering_refund_tasks where tenant_id = new.tenant_id and id = new.refund_task_id;
  if not found then return new; end if;
  select order_id, amount_krw into pay_order, pay_amount
    from public.ordering_payments where tenant_id = new.tenant_id and id = new.payment_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('pay:' || new.tenant_id::text || ':' || task_order::text, 0));
  if task_order <> new.order_id or pay_order <> new.order_id then
    raise exception 'the refund task, payment and ledger entry must belong to the same order' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.ordering_payment_confirmations where tenant_id = new.tenant_id and payment_id = new.payment_id)
     or exists (select 1 from public.ordering_payment_voids where tenant_id = new.tenant_id and payment_id = new.payment_id) then
    raise exception 'the refunded payment must be a confirmed, non-voided payment of this order' using errcode = 'P0001';
  end if;
  if new.amount_krw > task_required
       - coalesce((select sum(amount_krw) from public.ordering_refund_confirmations
                    where tenant_id = new.tenant_id and refund_task_id = new.refund_task_id), 0)
     or new.amount_krw > pay_amount
       - coalesce((select sum(reduced_krw) from public.ordering_payment_corrections
                    where tenant_id = new.tenant_id and payment_id = new.payment_id), 0)
       - coalesce((select sum(amount_krw) from public.ordering_refund_confirmations
                    where tenant_id = new.tenant_id and payment_id = new.payment_id), 0) then
    raise exception 'refund must not exceed the task remaining amount or the original payment available amount' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_refund_confirmations_guard_insert before insert on public.ordering_refund_confirmations
  for each row execute function private.guard_refund_confirmation_insert();

-- 권한: 서버 경로(service_role)만 읽고 추가한다. 클라이언트 역할에는 어떤 권한도 없다(RLS-03).
alter table public.ordering_payments enable row level security;
alter table public.ordering_payment_confirmations enable row level security;
alter table public.ordering_payment_voids enable row level security;
alter table public.ordering_payment_corrections enable row level security;
alter table public.ordering_refund_tasks enable row level security;
alter table public.ordering_refund_requests enable row level security;
alter table public.ordering_refund_request_decisions enable row level security;
alter table public.ordering_refund_confirmations enable row level security;
alter table public.ordering_refund_attempts enable row level security;
alter table public.ordering_refund_attempt_resolutions enable row level security;
revoke all on public.ordering_payments, public.ordering_payment_confirmations, public.ordering_payment_voids,
  public.ordering_payment_corrections, public.ordering_refund_tasks, public.ordering_refund_requests,
  public.ordering_refund_request_decisions, public.ordering_refund_confirmations, public.ordering_refund_attempts,
  public.ordering_refund_attempt_resolutions from public, anon, authenticated;
grant select, insert on public.ordering_payments, public.ordering_payment_confirmations, public.ordering_payment_voids,
  public.ordering_payment_corrections, public.ordering_refund_tasks, public.ordering_refund_requests,
  public.ordering_refund_request_decisions, public.ordering_refund_confirmations, public.ordering_refund_attempts,
  public.ordering_refund_attempt_resolutions to service_role;
