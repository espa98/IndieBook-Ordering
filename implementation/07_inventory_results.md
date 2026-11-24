# 07단계 결과 보고 — 입고·배분·재고·취소 물량 처분

작성 기준: 작업 트리 (`main`, 마지막 푸시 커밋 `ca9151d` 위에 ST-C07~C09 변경 포함). 이 문서는 실제로 실행해 확인한 것과 그렇지 않은 것을 구분해 기록한다.
공통 안전규칙이 요구한 5개 항목 순서를 따른다: (1) 읽은 문서와 충돌·미결정 (2) 변경 파일 (3) 실행한 명령과 실제 결과 (4) 미실행·미구현 (5) 다음 단계 승인 게이트.

## 0. 요약

검수 입고(ST-R01), 초과입고 Owner 결정(R02), 입고 정정(R03), 고객별 배분(R04)·해제(R05)·인도(R06)·재배분(R07), 매장 재고 수불(I01 초기 등록 · I02 증감 조정 · I03 예약 · I04 해제 · I05 인도), 취소 물량 처분(C01 취소 확정 · C02 반품 요청 · C03 공급처 회신 · C04 출고 · C05 완료 · C06 재고 편입 · C07 재협의 · C08 반송·분실 예외 · C09 예외 해소)을 **메모리 저장소 기준으로 TDD 구현**했다. 테스트 **836개가 통과**하고 `tsc` 오류는 없다. 06단계 보고서의 588개 대비 **+248개**다.

프롬프트가 요구한 테스트 중 **로트 8버킷 총량 보존, 교차 tenant, 분할 반품, 미회수 재고 편입 거부, 중복 편입 금지, 늦은 입고 초과 분리, 다른 도서/테넌트 격리**는 충족했다. **충족하지 못한 것:** "마지막 1권 **동시** 배분/예약"은 순차 호출로만 검증했고 **격리 DB가 없어 BLOCKED**다. **권한 검사·HTTP 진입점·OpenAPI는 07 전체에 없어서, 이 함수들을 외부에 노출하면 안 된다.**

## 1. 읽은 문서와 충돌·미결정 목록

### 1.1 읽은 문서
- 07단계 프롬프트(`07_입고_배분_재고_취소_물량_처분.md`), 공통 안전규칙(`00`)
- OPDS: DEC-09(민감 업무 승인), DEC-15(재배분 권한), DEC-18(취소 도서 처분), DEC-19(재고 권한), D30·D31
- STBR: ST-R01~R07, ST-I01~I06, ST-C01~C09, BR-Q01~Q22, BR-P03/P04, BR-C01~04, TC-61/64/71, §11.4~11.5
- Use Case: UC-10·11·13·23·26·27·28 (읽은 범위)

**읽지 않은 문서(한계):** ERD 본체, 구현현황표, FRD REC/INV 상세 본문, SFS, UC-12(고객 안내). 따라서 도서 카탈로그·수령(Fulfillment) 모델·안내 객체는 구현하지 않았다.

### 1.2 문서 간 충돌·모호함과 처리
| # | 내용 | 처리 |
|---|---|---|
| 1 | ST-R03(입고 정정)은 주체 `O/S`인데 승인된 DEC-09는 "거래 정정: Owner 승인, Staff는 요청" | **Owner 전용**으로 구현. Staff의 "정정 요청" 흐름은 없음 |
| 2 | ST-C01/C02/C06은 `O/승인 S`인데 Staff 승인 흐름이 아직 없음 | **Owner 전용**으로 기본 차단 |
| 3 | DEC-15는 OPDS 승인정책서에서 "승인 필요", STBR 본문에서는 "추가 결정 보류·미승인 고위험 명령 기본 차단" | 다른 고객으로의 재배분은 **Owner 전용**. 같은 고객 안 재배분(STAFF 허용)은 코드는 있으나 **다중 품목 주문 픽스처가 없어 테스트하지 못함** |
| 4 | "출고 후 거절/반송 시 자동 편입 금지, 실물 회수 후 별도 역거래" (STBR 159행)와 ST-C06 "REJECTED→STOCKED" | 공급처 **거절 수량**은 처분 대기로 복귀해 편입 가능, **반송·분실 예외 수량**은 `RECOVERED`(회수·검수 확인) 전까지 편입 불가 |
| 5 | BR-Q13 "취소 해제는 제외"의 정확한 의미 | 일반 해제(ST-R05)는 한도를 다시 열고, 취소 처분(C01)과 인도는 열지 않음 |
| 6 | 재고 편입 시 초기 재고가 등록되지 않은 도서 | 제 판단으로 **편입 거부**(BR-Q22와 ST-I02의 전제). 첫 재고를 편입으로 시작하게 하려면 변경 필요 |
| 7 | ST-C08/C09는 STBR이 "추가 전이(제안)"로만 정의, 주체 미정 | O/S 모두 가능으로 구현(제안) |

### 1.3 제가 정한 값 (문서에 없음, 확인 필요)
- **모델:** 입고·배분·반품·재고는 모두 **추가 전용 기록**이며 잔량·상태는 기록에서 파생한다(`allocationState`, `receiptBalances`, `stockLevel`, `cancellationPending`). 원 기록은 수정하지 않는다.
- **배분 잔량** `B = G − L − F − C`(생성 − 해제 − 인도 − 주문 취소 처분). OPEN/CLOSED는 `B > 0` 여부. 해제는 한도를 다시 열고, 인도와 취소 처분은 열지 않는다.
- **재고 예약 한도:** 가용량(보유−예약)과 품목 미배정량(`E − R − 활성 조달 배정`) 둘 다 만족. 입고 배분으로 확보된 수량은 `Need`와 `Planned`에서 동시에 빠지므로 별도 차감하지 않는다(BR-Q19).
- **처분 대기 잔량** = 취소 수량 − 재고 편입 − (반품 요청 − 공급처 거절 − 회수 확인).
- **위임:** 재고 조정을 점주가 위임한 Staff만 가능(`stockDelegations.isDelegated`). 위임 부여·철회 명령은 구현하지 않았다.
- **오류 코드:** 대상 없음·타 테넌트는 구별 불가한 동일 `NOT_FOUND`(404), 한도·상태 위반은 `BUSINESS_INVARIANT`(422), 입력 오류는 `VALIDATION_ERROR`(400), 권한 없음은 `FORBIDDEN`(403), 같은 키 다른 본문은 `IDEMPOTENCY_CONFLICT`(409).

## 2. 프롬프트 요구 대비

| 요구 | 상태 |
|---|---|
| 검수 입고와 고객별 배분을 별도 명령으로 | 구현 (`receiveGoods` / `allocateReceipt`) |
| 로트 8버킷 총량 보존, 고객 귀속 상한 | 구현 (`receiptBuckets` 이동 규칙, `receiptBalances` 합계 보존 테스트, 배분 상한 3중: 입고량·주문 품목 연결·발주 품목 누적) |
| 늦은 입고는 취소 고객에게 자동 배분 금지 | **부분 구현**: 취소 처분된 수량은 일반 미배분으로 돌아오지 않아 재배분 불가(BR-Q21). 주문 자체의 취소 상태는 모델이 없어 "취소된 주문에 신규 배분 차단"은 **미구현** |
| 초과입고 Owner 승인, 파손/오배송 별도 귀속 | 구현 (`decideExcessReceipt`, 입고 기록의 별도 필드) |
| 매장 재고 수불과 고객 주문 로트 분리 | 구현 (별도 원장·모듈, 입고 버킷과 합산하지 않음) |
| Staff 재고 실사 조정은 명시 위임 시만 | 구현 (`adjustStock`) |
| 취소 도서의 공급처 반품 또는 재고 편입은 Owner 결정 | 구현 (C02·C06 Owner 전용) |
| 부분 반품, 회수 검수 반영 | 구현 (요청·회신·출고·완료·예외·해소가 수량별) |
| 중복 편입 금지 | 구현 (`cancellationPending`, 멱등 키) |
| 미승인 타 고객 재배분(DEC-15) 활성화 금지 | **Owner 전용으로만 허용**, Staff 차단 (1.2의 3번) |
| 테스트: 마지막 1권 동시 배분 | **BLOCKED** (순차 경쟁만 검증: 예약 2건 중 1건만 성공) |
| 테스트: 로트 총량 보존 | 통과 (`receiptBalances` 시나리오마다 합계 단언) |
| 테스트: 교차 tenant/도서 | 통과 (모든 명령의 NOT_FOUND, 재고 도서·서점별 격리) |
| 테스트: 분할 반품 | 통과 (요청 2 → 수락 1·거절 1, 일부 출고·완료) |
| 테스트: 미회수 재고 편입 거부 | 통과 (반송 예외 미해소 수량 편입 거부, 회수 확인 후 허용) |

## 3. 구현

### 3.1 상태 흐름 (명령 → 버킷 이동)
| 전이 | 명령 | 버킷 이동 |
|---|---|---|
| R01 | `receiveGoods` | → `UNALLOCATED` (초과분은 별도 `excessQuantity`) |
| R04 | `allocateReceipt` | `UNALLOCATED → ALLOCATED_OPEN` |
| R05 | `releaseAllocation` | `ALLOCATED_OPEN → UNALLOCATED` |
| R06 | `deliverAllocation` | `ALLOCATED_OPEN → DELIVERED_NET` |
| R07 | `reallocateAllocation` | 해제 + 신규 배분을 **둘 다 검증 후 함께 저장** |
| C01 | `cancelAllocation` | `ALLOCATED_OPEN → DISPOSITION_PENDING` (BR-Q21) |
| C02 | `requestReturn` | `DISPOSITION_PENDING → RETURN_HELD` |
| C03 | `recordReturnReply` (거절분) | `RETURN_HELD → DISPOSITION_PENDING` |
| C04 | `dispatchReturn` | `RETURN_HELD → RETURN_DISPATCHED` |
| C05 | `completeReturn` | `RETURN_DISPATCHED → RETURNED_FINAL` |
| C06 | `transferCancelledToStock` | `DISPOSITION_PENDING → STOCK_TRANSFERRED` + 재고 원장 `CANCEL_TO_STOCK` |
| C08/C09 | `reportReturnException` / `resolveReturnException` | `RECOVERED`: `RETURN_DISPATCHED → DISPOSITION_PENDING`, `RETURNED`: `→ RETURNED_FINAL` |
| R03 | `correctReceipt` | 정상 순량 감소(미배분에서만) |

재고(매장 풀)는 별도 원장: I01 `registerInitialStock`, I02 `adjustStock`, I03 `reserveStock`, I04 `releaseStockReservation`, I05 `deliverStockReservation`(인도 기록 + 보유 감소 원장 항목).

### 3.2 파일
**프로덕션 (`src/inventory/`, 27개 파일):** 입고 `receiveGoods` `decideExcessReceipt` `correctReceipt` `receiptBuckets` `receiptBalances` / 배분 `allocateReceipt` `releaseAllocation` `deliverAllocation` `reallocateAllocation` `allocationState` / 취소·반품 `cancelAllocation` `cancellationPending` `requestReturn` `recordReturnReply` `dispatchReturn` `completeReturn` `reportReturnException` `resolveReturnException` `renegotiateReturn` `transferCancelledToStock` / 재고 `registerInitialStock` `adjustStock` `stockLevel` `stockReservation` `reserveStock` `releaseStockReservation` `deliverStockReservation`

**테스트:** `tests/inventory/` 25개 파일, 헬퍼 `tests/helpers/inventoryFixtures.ts`·`stockFixtures.ts`.

## 4. 실행한 명령과 실제 결과

| 명령 | 결과 |
|---|---|
| `npx vitest run` | Test Files 53 passed, Tests **836 passed** |
| `npx tsc --noEmit` | 오류 없음 |

**실행하지 않은 것:** lint(설정 없음), 빌드, CI(없음), 커버리지 측정, 실제 DB·HTTP 서버를 통한 요청(둘 다 없음).

07단계 커밋: `61ec712` 버킷 · `df297d3` 검수 입고 · `d9178aa` 초과입고 · `cb2bdb2` 배분 · `91bd2fc` 해제 · `8b07657` 인도 · `3e65fae` 재배분 · `3645489` 입고 정정 · `9fcf644` 초기 재고 · `c95f7a9` 증감 조정 · `098d9f1` 예약 · `17e0b12` 예약 해제 · `b7c2aef` 예약 인도 · `c9610ec` 취소 확정·편입 · `ca9151d` 반품 요청~완료. ST-C07~C09와 이 보고서는 작성 시점에 아직 커밋되지 않았다.

## 5. 검증 품질 (TDD 준수에 대한 정직한 기록)

### 5.1 TDD
- 새 동작은 실패하는 테스트(RED)를 먼저 확인한 뒤 구현했다. RED는 대부분 "모듈 없음" 또는 "예상한 오류가 던져지지 않음"이었다.
- **RED 없이 통과한 테스트**(보호용·기존 동작 고정): 각 명령의 "같은 멱등 키에 다른 내용 → 충돌"(공통 `executeIdempotent`가 이미 처리), 위임된 STAFF 허용, 인도 후 재예약 불가, 인도 후 조정 한도, 인도한 수량의 재배분 한도, 취소 수량의 재배분 한도, 미회수 편입 거부.
- **규칙 위반 기록:** "한 번에 하나의 테스트" 규칙을 세 번 어겼다(초과입고 멱등 두 건, 재배분 검증+NOT_FOUND 두 건, 입고 배분 멱등 두 건). 모두 같은 이유로 RED이거나 이미 통과였다.

### 5.2 기존 테스트 변경 (공개)
- **단언을 바꾼 적은 없다.** 바꾼 것은 모두 **장면(fixture)·입력 데이터**다:
  - 배분 멱등 도입 시 픽스처의 기본 멱등 키를 호출마다 고유하게 변경(서로 다른 배분이 같은 키를 쓰던 것이 충돌로 드러남).
  - 새 필수 의존성(`allocationReleases`, `allocationDeliveries`, `allocationCancellations`, `receiptCorrections`, `stockReservationReleases`, `stockReservationDeliveries`, `returnRequests`·`returnReplies`·`returnExceptions`·`returnExceptionResolutions` 등)이 생길 때마다 해당 장면에 저장소를 추가. 직접 deps를 조립하던 `transferCancelledToStock` 테스트 한 곳에는 빈 저장소를 추가.
- **테스트 작성 실수로 고친 것**(아직 통과한 적 없던 제 테스트): 재배분 장면의 `request` 이름 충돌, 해제 테스트의 반환 타입 단언, 재협의 테스트 제목 과장.

### 5.3 구조 변경
- `allocateReceipt`·`releaseAllocation`을 저장 없는 `validate*`/`plan*`과 저장 본체로 분리(동작 불변). 재배분이 "둘 다 통과해야 저장"하는 원자 처리를 하기 위함이다. 이 분리는 기존 테스트가 통과하는 상태에서 했다.

## 6. 알려진 한계·위험 (외부 노출 금지 사유)

1. **권한·인증 없음:** `actorRole`은 요청 값이다. 서버가 신원에서 역할을 도출하는 계층(04단계 결과 연결)이 없으므로 위조 가능하다. 위임(`stockDelegations`)도 조회 인터페이스만 있다.
2. **원자성은 "검증 후 연속 저장"이다.** 인도+원장, 재배분의 해제+배분, 편입+원장은 모두 검증을 통과한 뒤 순서대로 저장한다. 실제 DB 트랜잭션·부분 실패 롤백은 영속 계층에서 정해야 한다.
3. **동시성 미보장:** 한도 검증과 저장 사이에 다른 요청이 끼어드는 경쟁은 막지 못한다(격리 DB 필요, BLOCKED).
4. **주문 취소 모델 부재:** `E`(유효 주문량)는 품목 수량이고 ST-O05 부분 취소를 반영하지 않는다. 인도 합계 `F ≤ E`(BR-Q02) 통합 검증도 없다(재고 예약 인도와 입고 배분 인도가 각자 한도로만 막힌다).
5. **미구현:** 고객 안내·재안내(UC-12, 재배분·배분 정정 시 "안내 불일치 경고"), 위임 부여·철회 명령, Staff 승인 흐름, 도서 카탈로그 검증, 수령(Fulfillment) 모델, 감사 로그 필드, 입고 파손·오배송 정정, 취소된 주문에 대한 신규 배분 차단, 반품 비용 후속 업무.

## 7. 다음 단계 승인 게이트

07단계 범위의 도메인 함수는 완료했다. **자동으로 08단계(고객 안내·인도·결제 사실 기록)로 진행하지 않는다.** 진행 전 사용자 확인이 필요한 항목:
- 1.2의 권한 해석 3건(정정 Owner 전용, 취소·반품·편입 Owner 전용, DEC-15)을 이대로 둘지
- 편입 시 "초기 재고 등록 필수" 규칙(1.2의 6번)을 유지할지
- 변경분(ST-C07~C09, 이 보고서) 커밋·푸시 여부
