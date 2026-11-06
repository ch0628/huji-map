# 휴지맵 Antigravity 개발 설계 패키지

기준: 2026-11-06 / 상태: **설계 및 작업 지시서 — 앱 코드 미구현**

## 시작 방법 (사용자 최소 개입)

1. 압축을 풀어 **새 폴더**를 만든다. 압축 파일 속 `AGENTS.md`, `docs/`, `tasks/`는 **Antigravity에서 여는 workspace 최상단**에 둔다.
2. Antigravity에서 해당 폴더를 연다. 루트 `AGENTS.md`는 Antigravity의 워크스페이스 지침으로 읽힌다(Agent Settings 변화 시 수동 첨부 가능).
3. `START_HERE.md` 전문을 Antigravity 채팅에 한 번 붙여넣는다. **작업 00만** 수행하게 한다.
4. 작업 00의 PASS/FAIL 보고가 PASS이면, `tasks/01_....md`의 내용을 채팅에 붙여넣는다. 이후 **한 번에 하나의 작업 파일만** 전달한다.
5. `tasks/00` ~ `tasks/32`는 순서가 지정되어 있다. FAIL이면 다음으로 넘어가지 않고 해당 단계만 고친다.

> 자동으로 코드 작성/파일 수정/테스트는 Antigravity가 수행한다. 사용자가 직접 해야 할 가능성이 있는 작업은 Supabase·Kakao·Toss·Vercel 계정 개설, 약관 동의, 키 발급/승인 및 테스트 제휴 가게 허가에 한정한다. 키가 없는 동안에는 해당 외부 연동 기능을 안전하게 비활성화한다.

## 고정된 결정

- 모바일 우선 설치 없는 웹앱. Next.js App Router + TypeScript + Tailwind.
- Supabase Auth + PostgreSQL + private Storage. 모든 DB 접근은 Next.js 서버 API. 클라이언트는 서비스 역할 키(service role)를 절대로 사용하지 않는다.
- 지도: Kakao Maps JavaScript SDK. 지도 어댑터로 교체 가능하게 구현. WGS84 좌표.
- 공공 화장실: 무료/길찾기. 제휴 화장실: 같은 길찾기 + **보증금 결제 승인 후 이용권**, PIN 화장실은 권한 검증 후 PIN 표시.
- Toss Payments **테스트 모드만**. 실제 금전 결제/환급은 명시적 추후 결정 전까지 비활성화.
- 제휴 가게 등록: 무료(월 구독 결제 없음).
- 영수증: 사진 비공개 업로드 → **관리자 수동 승인/반려/재제출 요청** → 승인 시 테스트 결제 취소. OCR 없음.
- PMF: H1/H2/H5 이벤트 수집; 기존 판정선 유지. 보고서에 클릭과 실제 방문·결제를 혼동하지 않는다.
- 가상 크레딧 없음. 임의 별점, 가상의 실제 가게, 실제 결제 가정 금지.

## 문서 읽기 순서

- `AGENTS.md`: 프로젝트 전체에 걸쳐 절대 깨면 안 되는 규칙
- `docs/01_PRODUCT_AND_FLOWS.md`: 기능 및 유저 시나리오
- `docs/02_ARCHITECTURE.md`: 기술 구조·코드 경계
- `docs/03_DATA_MODEL.md`: **DB 전 테이블/필드 명세**
- `docs/04_API_CONTRACT.md`: API 동작 규약
- `docs/05_SCREEN_SPEC.md`: 모바일 화면 명세
- `docs/06_EVENTS_AND_PMF.md`: 행동 로그 및 실험
- `docs/07_PAYMENT_ACCESS_REFUND.md`: 거래·PIN·환급 상태
- `docs/08_SECURITY_OPERATIONS.md`: 보안/운영 통제
- `docs/09_TEST_AND_ACCEPTANCE.md`: 통합 수용기준
- `docs/10_CONFIG_AND_BLOCKERS.md`: 외부 계정/키 필요 목록
- `docs/11_DECISIONS.md`: 확정과 미확정을 엄격히 구별
- `tasks/`: **작업별 Antigravity 복사/붙여넣기 명령**

## 진행 추적

Antigravity가 `IMPLEMENTATION_STATUS.md`를 작성해 각 작업의 PASS/FAIL·변경 파일·테스트 명령 및 결과·다음 단계 차단 사유를 기록하게 되어 있다. 사용자가 코드 수정 없이 이 파일과 Agent 보고서만 확인할 수 있도록 한다.

## 중요한 한계

이번 패키지는 구현 설계와 작은 지시서 파일이다. **실제 Next.js 앱이 아직 작성된 것은 아니며**, 키를 발급하거나 외부 서비스를 연결하지 않았다. 모든 도메인/설정값은 예시이므로 본인 계정의 실제 값으로 Antigravity가 적용해야 한다.

