-- 017 배분 취소 처분 삽입 방어
-- 해제·인도에만 있던 배분 잔량 가드(배분 - 해제 - 인도 - 취소 처분)를 취소 처분 삽입에도 적용한다.
-- 주문 취소 적용과 배분 취소 명령 모두 같은 발주 품목 락('pol:')을 이미 잡고, 가드도 같은 키를 잡는다.
create trigger ordering_allocation_cancellations_guard_insert before insert on public.ordering_allocation_cancellations
  for each row execute function private.guard_allocation_movement_insert();
