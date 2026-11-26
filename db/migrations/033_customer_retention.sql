-- 033 고객 정보 보존기간(고객 결정 #2): 서점별로 Owner가 정한다. 마지막 활동 뒤 이 기간(일)이 지난 고객은 익명화 대상이다. null이면 기한 없음.
alter table public.ordering_tenants
  add column customer_retention_days int check (customer_retention_days is null or customer_retention_days between 1 and 3650);
