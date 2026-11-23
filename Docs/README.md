# BookFlow Ordering — AI 개발 프롬프트 기준 문서

이 Docs 폴더에는 Claude Code 및 Bolt.new 프롬프트를 **작성하는 데 직접 필요한 최신 기준 문서**만 포함합니다.

## 읽는 순서
1. `02_Policies/` — 승인된 운영 정책(OPDS)과 상태 전이(STBR). 승인되지 않은 정책은 구현하지 않습니다.
2. `01_Requirements/` — PRD, FRD, Use Case. P0 범위 및 인수 기준 확인.
3. `04_Database/` — ERD V2.1 및 검토서. 설계안이며 실DB 적용 검증 완료로 간주하지 않습니다.
4. `05_API_Security/` — API V2.2, RLS V2.2, 구현현황. 설계와 구현 상태를 구별합니다.
5. `03_UI_UX/` — IA, SFS, UI/UX 가이드. Bolt.new 화면 프롬프트 기준.

## AI별 주요 입력
- Claude Code: 정책 + FRD/UseCase + ERD + API/RLS + 구현현황표.
- Bolt.new: 정책 + PRD/UseCase + IA/SFS/UIUX + API/구현현황표.

## 안전 게이트
- `ordering-dev`의 스키마·데이터·RPC·RLS를 승인 없이 변경하지 않습니다.
- `testBookshare`는 접근하거나 변경하지 않습니다.
- 변경은 별도 격리 DB에서 검증한 뒤 사용자 승인을 받습니다.
- 실제 구현·테스트되지 않은 API를 구현 완료로 표현하거나 UI에서 성공으로 가장하지 않습니다.
- 운영 배포는 보류 상태입니다.

SQL 구현 초안 및 테스트 스크립트는 프롬프트 작성 기준 문서가 아니라 실행 참고 자료이므로 `Docs` 밖 `Ordering_Implementation_Archive/`에 별도 보관합니다.
