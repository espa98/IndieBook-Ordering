-- 018 결제 정정 방어, 수령 정정 기록, 주문 재개 기록
-- 주문 재개(closed_at 비우기)는 DB 수준에서 기록 없이도 허용한다(002 주문 DB 불변식 테스트가 명세다). 재개 기록은 서버 어댑터가 남긴다.
-- 락: 결제 정정은 주문 결제 락('pay:<서점>:<주문>', 결제·환급 어댑터와 같은 키), 수령 정정은 주문 인도 락('ful:').

-- 결제 정정은 확인된 결제에만, 누적 정정 + 확정 환급이 원 거래액을 넘지 않게(BR-Y08).
create function private.guard_payment_correction_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  amount bigint;
  corrected bigint;
  refunded bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('pay:' || new.tenant_id::text || ':' || new.order_id::text, 0));
  select amount_krw into amount from public.ordering_payments where tenant_id = new.tenant_id and id = new.payment_id;
  if not found then return new; end if;
  if not exists (select 1 from public.ordering_payment_confirmations where tenant_id = new.tenant_id and payment_id = new.payment_id) then
    raise exception 'only a confirmed payment can be corrected' using errcode = 'P0001';
  end if;
  select coalesce(sum(reduced_krw), 0) into corrected from public.ordering_payment_corrections where tenant_id = new.tenant_id and payment_id = new.payment_id;
  select coalesce(sum(amount_krw), 0) into refunded from public.ordering_refund_confirmations where tenant_id = new.tenant_id and payment_id = new.payment_id;
  if new.reduced_krw > amount - corrected - refunded then
    raise exception 'the correction exceeds the remaining amount of the payment' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_payment_corrections_guard_insert before insert on public.ordering_payment_corrections
  for each row execute function private.guard_payment_correction_insert();

-- 수령 정정 기록(추가 전용). 원 수령은 바꾸지 않고 음수 수령 행(역거래)과 출처별 복원 기록을 더한다(ST-F02, D21).
-- 역거래가 수령 원장에 음수 행으로 들어가므로 "수령한 것보다 많이 되돌릴 수 없다"는 한도는 수령 가드(006)가 이미 막는다.
create table public.ordering_fulfillment_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  fulfillment_id uuid not null,
  reversal_fulfillment_id uuid not null,
  quantity int not null check (quantity >= 1),
  restorations jsonb not null,
  reason text not null check (btrim(reason) <> ''),
  evidence text not null check (btrim(evidence) <> ''),
  corrected_by text not null check (btrim(corrected_by) <> ''),
  corrected_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, fulfillment_id) references public.ordering_fulfillments (tenant_id, id),
  foreign key (tenant_id, reversal_fulfillment_id) references public.ordering_fulfillments (tenant_id, id)
);
create trigger ordering_fulfillment_corrections_append_only before update or delete on public.ordering_fulfillment_corrections
  for each row execute function private.forbid_mutation();
alter table public.ordering_fulfillment_corrections enable row level security;
revoke all on public.ordering_fulfillment_corrections from public, anon, authenticated;
grant select on public.ordering_fulfillment_corrections to authenticated;
grant select, insert on public.ordering_fulfillment_corrections to service_role;
create policy ordering_fulfillment_corrections_select on public.ordering_fulfillment_corrections for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));

-- 주문 재개 기록(추가 전용). 종결 뒤 승인된 정정으로 종결 조건이 깨져 서버가 재개했다는 사실이다(ST-O10).
create table public.ordering_order_reopenings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  trigger_kind text not null check (trigger_kind in ('PAYMENT_CORRECTION', 'FULFILLMENT_CORRECTION')),
  trigger_id uuid not null,
  blockers jsonb not null,
  order_version_before bigint not null,
  order_version_after bigint not null,
  executed_by text not null check (executed_by = 'SYSTEM'),
  reopened_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (order_version_after = order_version_before + 1),
  foreign key (tenant_id, order_id) references public.ordering_orders (tenant_id, id)
);
create index ordering_order_reopenings_order_idx on public.ordering_order_reopenings (tenant_id, order_id);
create trigger ordering_order_reopenings_append_only before update or delete on public.ordering_order_reopenings
  for each row execute function private.forbid_mutation();
alter table public.ordering_order_reopenings enable row level security;
revoke all on public.ordering_order_reopenings from public, anon, authenticated;
grant select on public.ordering_order_reopenings to authenticated;
grant select, insert on public.ordering_order_reopenings to service_role;
create policy ordering_order_reopenings_select on public.ordering_order_reopenings for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
