# TASK 23 — 도어락 비밀 저장/교체

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 23만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 도어락 비밀 저장/교체

**읽을 명세:** docs/03_DATA_MODEL.md, docs/08_SECURITY_OPERATIONS.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `supabase/migrations/**`, `src/lib/access/crypto/**`, `src/app/api/v1/merchant/restrooms/**`, `tests/**`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** `restroom_lock_secrets` 암호문 테이블과 AES-256-GCM 암호화 헬퍼, 검증된 owner PIN 생성/변경/버전·유효기간 관리, 권한/감사 기록 작성. 사용자 PIN 공개 엔드포인트는 다음 작업으로 남긴다.

**완료 기준:** plain PIN DB/로그/응답 0, merchant A가 B PIN 변경 불가, rotate 성공/키 누락 시 안전 실패.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 23에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

