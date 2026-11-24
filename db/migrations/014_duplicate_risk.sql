-- 014 중복 구매 위험 승인 (BR-P05)
-- 배정을 풀었지만 공급처 의무가 남은 품목을 다른 공급처로 재조달하려면 Owner의 승인과 남는 물량 처리 계획이 필요하다.
-- 승인은 추가 전용이며 이전 의무를 지우지 않는다. 의무가 열려 있는지는 해제 기록·회신·취소 응답·입고에서 파생하므로
-- 배정 시 검사는 어댑터가 주문 품목 락('sline:') 아래에서 하고, 해제도 같은 락을 잡아 경쟁하지 않는다.

create table public.ordering_duplicate_risk_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  purchase_order_id uuid not null,
  po_line_id uuid not null,
  surplus_plan text not null check (surplus_plan in ('STOCK_INTAKE', 'SUPPLIER_RETURN')),
  plan_note text not null check (btrim(plan_note) <> ''),
  approved_by text not null check (btrim(approved_by) <> ''),
  approved_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, order_id, order_line_id) references public.ordering_order_lines (tenant_id, order_id, id),
  foreign key (tenant_id, purchase_order_id, po_line_id) references public.ordering_po_lines (tenant_id, purchase_order_id, id)
);
create index ordering_duplicate_risk_approvals_order_idx on public.ordering_duplicate_risk_approvals (tenant_id, order_id);
create trigger ordering_duplicate_risk_approvals_append_only before update or delete on public.ordering_duplicate_risk_approvals
  for each row execute function private.forbid_mutation();
alter table public.ordering_duplicate_risk_approvals enable row level security;
revoke all on public.ordering_duplicate_risk_approvals from public, anon, authenticated;
grant select on public.ordering_duplicate_risk_approvals to authenticated;
grant select, insert on public.ordering_duplicate_risk_approvals to service_role;
create policy ordering_duplicate_risk_approvals_select on public.ordering_duplicate_risk_approvals for select to authenticated using (private.is_ordering_member(tenant_id, array['OWNER', 'STAFF']));
