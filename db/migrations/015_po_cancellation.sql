-- 015 발주 취소 요청·응답 방어
-- 공급처 취소 요청·응답은 전달된 발주(SENT·ACKNOWLEDGED)에만 넣을 수 있고, 요청은 발주 품목 수량 이하,
-- 한 요청에 대한 응답(수락+거절)의 합은 요청량 이하여야 한다(BR-P02). 발주 품목 단위 락('pol:')을 어댑터와 같은 키로 잡는다.
-- 요청 가능 수량(유효 발주량 − 미응답 요청)과 수락된 취소 + 품절 확정 ≤ 발주량 불변식은 회신 이벤트의 풀 계산이 필요해
-- 어댑터가 발주 품목 락 아래에서 지키고 DB는 검사하지 않는다(회신·입고와 같은 한계).

create function private.guard_po_cancellation_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_status text;
  line_quantity int;
  request_quantity int;
  answered bigint;
begin
  select status into current_status from public.ordering_purchase_orders where tenant_id = new.tenant_id and id = new.purchase_order_id;
  if current_status is null or current_status not in ('SENT', 'ACKNOWLEDGED') then
    raise exception 'a cancellation can only be handled for a sent purchase order' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pol:' || lower(new.tenant_id::text) || ':' || lower(new.po_line_id::text), 0));
  if tg_table_name = 'ordering_po_cancellation_requests' then
    select quantity into line_quantity from public.ordering_po_lines where tenant_id = new.tenant_id and id = new.po_line_id;
    if new.quantity > line_quantity then
      raise exception 'the cancellation request exceeds the purchase order line quantity' using errcode = 'P0001';
    end if;
  else
    select quantity into request_quantity from public.ordering_po_cancellation_requests where tenant_id = new.tenant_id and id = new.request_id;
    select coalesce(sum(accepted_quantity + rejected_quantity), 0) into answered from public.ordering_po_cancellation_responses
     where tenant_id = new.tenant_id and request_id = new.request_id;
    if answered + new.accepted_quantity + new.rejected_quantity > request_quantity then
      raise exception 'the responses exceed the requested cancellation quantity' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger ordering_po_cancellation_requests_guard_insert before insert on public.ordering_po_cancellation_requests
  for each row execute function private.guard_po_cancellation_insert();
create trigger ordering_po_cancellation_responses_guard_insert before insert on public.ordering_po_cancellation_responses
  for each row execute function private.guard_po_cancellation_insert();
