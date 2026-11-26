-- 025 주문 목록 인덱스: 목록은 서점별 최신순(created_at, id 내림차순) 커서 페이지네이션이다.
-- 이 인덱스가 있으면 한 페이지가 서점의 주문 수와 무관하게 정렬 없이 읽힌다.
create index ordering_orders_tenant_created_idx
  on public.ordering_orders (tenant_id, created_at desc, id desc);
