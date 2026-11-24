-- 009 취소 물량 처분(재고 편입·반품 요청)
-- 같은 취소 물량은 한 번만 처분한다: 재고 편입 + (반품 요청 - 회수 확인된 예외 수량) 이 취소 수량을 넘을 수 없다(BR-Q15, ST-C06).
-- 공급처 회신(반품 거절)은 아직 영속화하지 않아 세지 않는다. 그래서 DB 방어는 도메인보다 보수적이다(거절 수량이 다시 처분 대기가 되는 일은 막힌다).
-- 락: 취소 물량 단위('dsp:') 어드바이저리 락. 어댑터의 락(주문 행 -> 'ful:' -> 책 락)보다 항상 나중에 잡는다.

create function private.guard_cancellation_disposition_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cancelled int;
  intaken bigint;
  held bigint;
  recovered bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('dsp:' || new.tenant_id::text || ':' || new.cancellation_id::text, 0));
  select quantity into cancelled from public.ordering_allocation_cancellations
   where tenant_id = new.tenant_id and id = new.cancellation_id;
  select coalesce(sum(quantity), 0) into intaken from public.ordering_stock_intakes
   where tenant_id = new.tenant_id and cancellation_id = new.cancellation_id;
  select coalesce(sum(quantity), 0) into held from public.ordering_return_requests
   where tenant_id = new.tenant_id and cancellation_id = new.cancellation_id;
  select coalesce(sum(r.quantity), 0) into recovered from public.ordering_return_exception_resolutions r
    join public.ordering_return_exceptions e on e.tenant_id = r.tenant_id and e.id = r.return_exception_id
    join public.ordering_return_requests q on q.tenant_id = e.tenant_id and q.id = e.return_request_id
   where r.tenant_id = new.tenant_id and q.cancellation_id = new.cancellation_id and r.outcome = 'RECOVERED';
  if intaken + held - recovered + new.quantity > cancelled then
    raise exception 'the disposition exceeds the pending quantity of the cancellation' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ordering_stock_intakes_guard_disposition before insert on public.ordering_stock_intakes
  for each row execute function private.guard_cancellation_disposition_insert();
create trigger ordering_return_requests_guard_disposition before insert on public.ordering_return_requests
  for each row execute function private.guard_cancellation_disposition_insert();
