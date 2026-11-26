-- 026 멱등 기록 결과 버전. 정책: 저장된 결과의 JSON 형태가 바뀌면 오래된 기록은 삭제한다(옛 형태를 해석하는 변환 코드를 두지 않는다).
-- 결과 형태를 바꾸는 변경은 서버의 RESULT_SCHEMA_VERSION을 올린다. 서버는 현재 버전보다 낮은 기록을 읽을 때 삭제하고 없는 것으로 본다.
-- 영향: 그 키의 재시도는 새 요청으로 다시 실행된다(같은 키로 이미 처리된 명령이 한 번 더 실행될 수 있다).
alter table public.ordering_commands add column result_version int not null default 1;
grant delete on public.ordering_commands to service_role;
