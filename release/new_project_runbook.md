# 새 Supabase 프로젝트 전환 런북 (옵션 A, E5-2 결정 2026-11-25)

대상: 단계 1(확장)~3(검증). 근거: `release/legacy_rpc_analysis.md` §6. 이 문서는 **절차와 점검표**이며, 어떤 단계도 아직 실행하지 않았다. 새 프로젝트 생성(E5-3)이 먼저 승인·수행되어야 한다.

## 0. 원칙

- **레거시 `ordering-dev`에는 아무것도 적용하지 않는다.** 마이그레이션 도구는 이 안전장치를 코드로 갖고 있다(§2): 이력 없이 `ordering*` 테이블이 이미 있는 DB는 적용을 거부한다(레거시는 테이블 5개가 겹쳐 차단된다).
- 접속 문자열·키는 **환경 변수로만** 다룬다. 이 저장소·로그·채팅에 남기지 않는다.
- 파괴적 작업(`DROP`, `REVOKE`)은 이 런북에 없다.

## 1. 사전 준비 (사용자)

| 항목 | 내용 | 확인 |
|---|---|---|
| 새 프로젝트 | Supabase에서 **새 프로젝트**를 만든다(E5-3: 비용·관리 주체 결정). 레거시와 다른 프로젝트여야 한다 | [ ] |
| Auth: 이메일 확인 | Authentication → Providers → Email의 **Confirm email을 켠다.** 초대 수락(§49)·서점 개설(§50)의 이메일 신뢰가 이 설정에 기댄다(`release/approval_items.md` 부록) | [ ] |
| Auth: 비밀번호 보호 | 유출 비밀번호 보호를 켠다(Security Advisor 경고 항목) | [ ] |
| DB 접속 | DB 사용자가 `SET LOCAL ROLE service_role`/`authenticated`를 할 수 있어야 한다(서버가 매 트랜잭션에서 한다). Supabase의 기본 `postgres` 사용자는 가능하다. **풀러 모드(세션/트랜잭션)별 동작은 이 저장소에서 검증하지 못했다 — 직접 접속 또는 세션 풀러를 권하며, 트랜잭션 풀러를 쓰면 3단계에서 확인한다** | [ ] |
| JWT 키 | 새 프로젝트의 JWT 서명 방식(비대칭 키/JWKS 또는 레거시 HS256 비밀)을 확인해 서버 설정에 맞춘다(§3). **Supabase의 현재 기본값은 이 저장소에서 확인하지 못했다** | [ ] |

## 2. 마이그레이션 적용 (단계 1: 확장)

도구: `npm run migrate`(`server/migrate.ts` → 번들 `dist/migrate.mjs`, 본체 `server/migrateCli.ts`). 저장소 체크아웃에서 실행한다. 기본은 **읽기 전용 드라이런**이다.

1. **드라이런** — 아무것도 바꾸지 않고 대상과 대기 목록, 차단 사유를 보여 준다.
   ```
   DATABASE_URL='postgresql://…' npm run migrate
   ```
   기대 출력: `대상: <새 프로젝트 호스트> (드라이런)`, `적용됨 0개, 대기 24개`, 차단 없음.
   - 출력된 **호스트가 새 프로젝트인지 확인**한다. 레거시 호스트이면 중단한다.
   - 종료 코드: `0` 정상, `1` 차단/접속 실패, `2` 사용 오류.
2. **적용** — 호스트를 직접 적어 확인해야만 적용된다.
   ```
   DATABASE_URL='postgresql://…' npm run migrate -- --apply --confirm-host <위에서 확인한 호스트>
   ```
   - `--confirm-host`가 없거나 접속 호스트와 다르면 거부(코드 2).
   - 각 마이그레이션은 한 트랜잭션이라 실패하면 그 파일만 롤백되고 이력에 남지 않는다. 이미 적용한 파일이 바뀌면 거부한다.
   - 다시 실행하면 `대기 0개`가 나온다.
3. 도구가 **자동으로 막는 것**(적용 전 점검, 모두 코드·테스트로 확인됨): ① 이력 없이 `ordering*` 테이블이 있는 DB(레거시 등) ② Supabase 역할(`anon`/`authenticated`/`service_role`) 누락 ③ `auth.uid()` 없음(Supabase Auth가 없는 DB) ④ 적용된 파일의 변경.

## 3. 서버 환경 변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | 예 | 서버가 쓰는 DB 연결 문자열 |
| `SUPABASE_JWT_KEYS` | 둘 중 하나 이상 | RS256/ES256 공개 키 JSON 배열(`[{"kid","alg","key"}]`) |
| `SUPABASE_JWT_SECRET` | 〃 | HS256 비밀(32자 이상) |
| `SUPABASE_JWT_ISSUER` | 권장 | 발급자(`iss`) 검증 |
| `PORT` | 아니오 | 기본 8080 |
| `MAX_BODY_BYTES` | 아니오 | 기본 1 MiB |
| `DB_STATEMENT_TIMEOUT_MS` | 아니오 | DB 쿼리 하나의 시간 제한(잠금 대기 포함). 기본 10000, 100~120000 |
| `YES24_BOOK_SEARCH_URL` | 아니오(키와 함께) | YES24 상품 검색 주소(DEC-17). 실제 서비스는 `https://apis.yes24.com/v1/goods/itemList`. **https**여야 한다(로컬 개발 주소만 http). 없으면 도서 검색은 503이고 수기 등록을 쓴다 |
| `YES24_API_KEY` | 〃(주소와 함께) | YES24 Developers에서 발급한 API 키. `X-Api-Key` 헤더로만 보내고 로그·오류·응답에 싣지 않는다. 비밀이므로 실행 환경에서만 주입한다(서버는 `.env`를 자동으로 읽지 않으니 로컬에서는 `node --env-file=.env dist/server.mjs`) |
| `YES24_TIMEOUT_MS` | 아니오 | 상류 요청 제한 시간. 기본 5000, 500~30000 |
| `CLOSURE_SWEEP_INTERVAL_SECONDS` | 아니오 | 종결 스위퍼 간격, 기본 300, 0이면 끔 |
| `CORS_ALLOWED_ORIGINS` | 아니오 | 허용 오리진(쉼표 구분). **비우면 브라우저 오리진을 허용하지 않는다**(E9: 값 결정 필요) |

**YES24 도서 검색 상류 계약(확인됨, 2026-11-26):** YES24 Developers 문서(`developers.yes24.com/api-doc/goods-item-list`)와 실제 호출로 확인했다. 서버(`src/catalog/yes24Provider.ts`)는 제목·저자 검색에 `GET {url}?query=<검색어>&category=BOOK&pageSize=<limit>`(상품 검색 `itemList`), **ISBN 검색에는 같은 위치의 `itemDetail`**(`GET https://apis.yes24.com/v1/goods/itemDetail?searchType=ISBN13&query=<ISBN-13>`, 상품 상세 조회)을 헤더 `X-Api-Key`와 함께 보내고 `200 {success, data:{items:[…]}}`를 읽는다(`itemId`→id, `author`, `isbn13`/`isbn10`, `publisher`, `publishDate`(YYYYMMDD→YYYY-MM-DD), `shopPrice`→정가, `cover`, `link`). **제목·저자 검색은 자유 텍스트 `query` 하나뿐이라 둘을 구분하지 못한다. ISBN 검색은 ISBN-13만 되고(ISBN-10은 400) 서버가 응답의 ISBN-13이 같은 것만 남긴다.** 결과 없음은 검색 404 `SEARCH_001`·상세 404 `GOODS_001`/`GOODS_002`(→ 빈 목록), 키 오류(401)·속도 제한(429)·상류 장애(502/504)는 503 `SERVICE_UNAVAILABLE`이다. 속도 제한은 키 단위(기본키 하루 20,000회·초당 10회, 제휴키 100,000/20).
**YES24 이용약관 준수(운영 책임):** ① 검색 결과를 보여 주는 화면은 **출처가 YES24임을 표시하고 `detailUrl`(YES24 상세 페이지)로 연결**해야 한다(약관 6조 ③ 4). ② 데이터를 체계적으로 대량 수집해 별도 DB로 쌓는 것은 금지다 — 이 서버는 직원이 선택한 도서만 서점 카탈로그에 등록한다(대량 수집·일괄 저장 기능을 만들지 말 것). ③ 키는 이용 주체별 1개이며 제3자와 공유하거나 브라우저 코드에 넣지 않는다. ④ 가격·재고는 운영 정책의 갱신 주기에 맞춰 최신으로 유지해야 하므로 외부 정가는 참고값으로만 쓴다(서점 판매가는 직원이 따로 입력). 약관 해석은 법률 검토가 아니다.

비밀은 이미지·저장소가 아니라 실행 환경에서 주입한다(`Dockerfile` 주석 참조). 이미지 빌드는 이 PC에 Docker가 없어 **검증하지 못했다.**

## 4. 검증 (단계 3) — 아직 아무것도 실행하지 않았다

격리 DB에서의 검증(테스트 142개 파일, 1427개)은 끝났다. 아래는 **실제 Supabase에서만 확인할 수 있는** 항목이며 Go/No-Go의 차단 조건(T1~T3, T6)에 대응한다.

| 항목 | 방법 | 대응 |
|---|---|---|
| DDL·FK·RLS·트리거 실제 적용 | §2 적용이 오류 없이 끝나는지, `release/legacy_readonly_inspection.sql`(읽기 전용)을 **새 프로젝트에** 실행해 테이블·정책·권한이 기대와 같은지 | T1 |
| 실제 Auth 계정 2개와 JWT | 서로 다른 서점의 계정 2개를 실제로 가입·이메일 확인·로그인해 토큰으로 HTTP 호출(서점 개설·초대 수락 포함). 교차 서점 요청이 404/403인지 | T2 |
| 비활성 계정·권한 회수 직후 접근 | 직원을 비활성화한 직후의 요청이 403인지 | T2 |
| 두 세션 동시성 | 같은 마지막 1권 동시 배분, 동시 환급, 동시 초대 수락 | T3 |
| Security Advisor·함수 권한·RLS 전수 | 대시보드의 Advisor 결과, `has_function_privilege` | T6 |
| 풀러 호환 | `SET LOCAL ROLE`·어드바이저리 락이 쓰는 풀러 모드에서 동작하는지 | §1 |
| 서버 번들 기동 | `npm run build` 뒤 `node dist/server.mjs`로 `/healthz` 확인, 이미지 빌드 | T8 |

## 5. 롤백

| 단계 | 롤백 |
|---|---|
| 적용(§2) 중 실패 | 실패한 파일은 자동 롤백된다. 새 프로젝트를 쓰지 않으면 된다(레거시는 건드리지 않았다) |
| 적용 후 문제 발견 | 새 프로젝트를 폐기하고 새로 만든다(데이터가 아직 없다). 운영 데이터가 생긴 뒤에는 `release/rollback_plan.md`의 백업·복원 절차를 따른다 |
| 전환 후 | 프런트 라우팅을 레거시로 되돌린다. 레거시는 끄지 않는다(정리는 별도 승인, E5-4) |

## 6. 이 런북이 다루지 않는 것

프런트엔드 호출 계층의 HTTP 클라이언트 교체(R3), 레거시 RPC의 `authenticated` EXECUTE 철회와 `ordering-dev` 폐기(E5-4), 호스팅·시크릿 관리 방식(E8), 속도 제한(앞단 권고).
