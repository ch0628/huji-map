# TASK 16 — 지도 카드·상세·길찾기 UX

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 16만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 지도 카드·상세·길찾기 UX

**읽을 명세:** docs/05_SCREEN_SPEC.md, docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `src/app/(public)/**`, `src/components/map/**`, `src/components/restroom/**`, `tests/**`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** 공용 조회 API를 사용하는 모바일 지도/검색/공공·제휴 필터/조건 상세·길찾기 UI 완성. 공공: 결제 버튼 없음; 제휴: 보증금/조건+결제 진입 가능(아직 PG 구현 전 기능 준비 중 표기). 길찾기와 결제 별도 버튼. 지도 클릭만으로 실제 이용했다고 기록하지 않는다.

**완료 기준:** 공공 및 제휴 길찾기 모두 작동, 미승인 제휴 없음, 360px UI, 빈/오류 처리.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 16에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

