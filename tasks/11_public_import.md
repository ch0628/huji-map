# TASK 11 — 공공 화장실 데이터 수집기

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 11만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 공공 화장실 데이터 수집기

**읽을 명세:** docs/03_DATA_MODEL.md, docs/08_SECURITY_OPERATIONS.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `src/lib/imports/**`, `scripts/import-public-restrooms.*`, `tests/fixtures/public/**`, `tests/unit/import*`, `docs/import_runbook.md`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** 선택한 공공데이터의 공식 CSV/API 스키마 확인 후 필드 매핑/좌표 검증/중복 업서트/라이선스·원천ID·갱신시각 저장과 실행 로그 처리. 실제 API 키 없으면 공개 CSV 테스트 fixture로 파서 검증, import API 성공 가정 금지. 이미 존재하는 record를 중복 추가하지 않는다.

**완료 기준:** 동일 자료 2회 수입해도 중복 0, 불명 좌표 격리, 실패 시 기존 DB 보존, 출처 기록.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 11에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

