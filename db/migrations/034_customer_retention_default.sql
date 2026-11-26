-- 034 고객 정보 보존기간 기본값 15일(사용자 결정 2026-11-27). 새 서점은 15일로 시작하고, 기존 서점도 15일로 맞춘다.
-- Owner는 서점 설정에서 언제든 바꾸거나(1~3650일) null로 해제할 수 있다. 익명화는 Owner가 보존기간 적용을 실행할 때만 일어난다.
alter table public.ordering_tenants alter column customer_retention_days set default 15;
update public.ordering_tenants set customer_retention_days = 15 where customer_retention_days is null;
