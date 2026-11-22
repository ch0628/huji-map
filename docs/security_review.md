# HUJIMAP — 보안 점검 보고서 (TASK 32)

기준일: 2026-11-22  
대상: 로컬 코드 + 원격 Supabase `wddnbycimcixskemssct` (22/22 동기화 완료; 스테이징 Cloud Run 배포는 Git push 대기)  
참고 명세: [docs/08_SECURITY_OPERATIONS.md](file:///c:/Users/ASUS/Documents/Antigravity/toilet/docs/08_SECURITY_OPERATIONS.md), [docs/09_TEST_AND_ACCEPTANCE.md](file:///c:/Users/ASUS/Documents/Antigravity/toilet/docs/09_TEST_AND_ACCEPTANCE.md), [docs/10_CONFIG_AND_BLOCKERS.md](file:///c:/Users/ASUS/Documents/Antigravity/toilet/docs/10_CONFIG_AND_BLOCKERS.md)

---

## 1. 인증 및 역할·권한 접근 통제 (Auth & RBAC)

| 대상 영역 | 검증 내용 | 근거 및 결과 |
|---|---|---|
| 서버 인증 | `@supabase/ssr` 쿠키 + `supabase.auth.getUser()` 기반 서버 신원 검증 (`requireAuth`, `requireRole`) | **PASS** — `auth_ui.test.ts` (14/14), `auth_navigation.test.tsx` (10/10) |
| Cloud Run 테스트 모킹 차단 | `isCloudDeploymentRuntime()`(`K_SERVICE`, `CLOUD_RUN_JOB`, `VERCEL_ENV=production`) 시 `isE2eMockSessionAllowed()` false 반환 및 `/api/v1/auth/guard` `404` 차단 | **PASS** — `cloud_run_deploy.test.ts` (17/17), 실스테이징 `GET /api/v1/auth/guard?summary=1` -> `404` |
| 비회원/일반회원 관리자 차단 | `/admin`, `/admin/businesses`, `/admin/restrooms`, `/admin/receipts`, `/admin/refunds`, `/admin/analytics/pmf` 및 `/api/v1/admin/**` 서버 게이트(401/403) | **PASS** — 단위 테스트 + Chrome 360px E2E(`test_admin_business_approval_mobile.mjs`, `test_admin_restroom_review_mobile.mjs`, `test_admin_receipt_review_mobile.mjs`, `test_pmf_dashboard_mobile.mjs`, `test_admin_refunds_mobile.mjs`) + 실스테이징 `/api/v1/admin/refunds` `401` |
| 점주 리소스 격리 | 타 점포 조회·수정·심사 요청·PIN 회전·사진 관리 403 차단, 미승인 점포/가게 공개·발행 차단 | **PASS** — `business_backend.test.ts` (26/26), `restroom_merchant_api.test.ts` (48/48), PGlite 통합 검증 |
| 고객 이용권·영수증 격리 | `access_sessions` / `receipt_submissions` 조회·제출·PIN 공개 시 `user_id === auth.uid()` 강제(점주/관리자라도 타인 PIN 조회 불가) | **PASS** — `access_pin_reveal.test.ts` (24/24), `receipt_backend.test.ts` (23/23), `test_access_pin_ui_mobile.mjs` |

---

## 2. 데이터베이스 RLS 및 불변성 (PostgreSQL / Supabase)

- **원격 DB (`wddnbycimcixskemssct`) 읽기 전용 점검 결과**:
  - 마이그레이션 동기화: 로컬·원격 **22/22** (`20261106000000` ~ `20261123010000`) 일치 (`20261123000000_receipt_reject_resubmission_guard.sql`, `20261123010000_prevent_duplicate_restroom_policy.sql` 원격 적용 및 카탈로그 사후 검증 PASS).
  - `public` 스키마 **29개 전 테이블 `rowsecurity = true`** 확인 (`pg_tables` 직접 조회).
  - 공개 카탈로그 API(`src/lib/restrooms/service.ts`)는 `select("*")` 미사용(명시적 허용 컬럼 목록 사용), `restroom_lock_secrets`·사업자등록번호·내부 키 제외.
- **민감 컬럼 및 상태 불변성(PGlite 20건 마이그레이션 + 롤백 SQL 검증 통과)**:
  - `payment_orders` (`provider_payment_key`, `idempotency_key`), `payment_refunds` (`provider_cancel_id`, `idempotency_key`, `requested_by`), `access_sessions` (`idempotency_key`): `authenticated` 직접 `SELECT` 차단 및 API `toPublic*` 변환 제거.
  - `enforce_payment_order_rules`: `approved` 주문 사후 금액/상태/결제키 변조 차단 (`HM032`/`HM033`/`HM036`).
  - `enforce_access_session_rules`: `test_deposit` 정책 이용권의 `approved` 결제 부재 시 `authorized` 전이 차단 (`HM022`).
  - `audit_logs`, `pin_reveal_audits`, `receipt_review_audits`: append-only 트리거로 `UPDATE`/`DELETE` `42501` 차단.

---

## 3. 도어락 PIN 보안

- **저장 암호화**: AES-256-GCM + 랜덤 IV + HMAC 무결성 (`src/lib/access/crypto/`), `PIN_ENCRYPTION_KEY_BASE64` 서버 전용 환경변수.
- **공개 통제 (`POST /api/v1/access/:id/reveal-pin` + `reveal_access_pin` / `confirm_pin_revealed`)**:
  - 검증 조건: 본인 세션 + `active` 계정 + 승인 제휴 화장실 + `authorized`/`code_revealed` + 만료 전 + 서버 DB `payment_orders.status='approved'` + 활성 환불/취소 부재(`requested`/`processing`/`succeeded` 시 `422 PAYMENT_REFUNDED`).
  - 응답 헤더: `Cache-Control: private, no-store, no-cache, must-revalidate`, `Pragma: no-cache`, `Expires: 0`.
  - 분당 최대 10회 Rate Limiting 적용 (`checkRateLimit`).
  - 동시 회전 방어: 복호화 중 PIN 회전 시 `409 PIN_STALE_ROTATED` 거부 (`test_access_pin_ui_mobile.mjs` 및 PGlite 검증).
- **비노출 확인**: 공개 상세 API(`/api/v1/restrooms/:id`) 응답에 `pin` 관련 필드 없음 확인(스테이징 `진미 통닭` 실호출 포함), `pin_reveal_audits`·`audit_logs` 평문/암호문 비저장 확인.

---

## 4. 영수증 비공개 Storage 및 수동 심사·환급 분리

- **원격 Storage 버킷 점검 (`storage.buckets`)**:
  - `receipts`: `public = false`, `file_size_limit = 10485760` (10MB), `allowed_mime_types = ['image/jpeg', 'image/png', 'image/webp']`.
  - `restroom-photos`: `public = false`, `file_size_limit = 10485760` (10MB), `allowed_mime_types = ['image/jpeg', 'image/png', 'image/webp']`.
- **업로드·심사·환급 분리**:
  - `POST /api/v1/receipts`는 서버가 Storage 객체를 직접 다운로드해 실제 크기·매직바이트(`verifyReceiptMagicBytes`)를 검증.
  - 고객 UI(`/my/receipts`)에 자가 승인/환급 버튼 0건 (`test_receipt_customer_ui_mobile.mjs` PASS).
  - 영수증 승인(`approved`)과 PG 환급(`payment_refunds`) 분리: 환급은 관리자 전용 `POST /api/v1/admin/refunds/:paymentOrderId/request` 및 `reconcile`을 통해서만 실행.
  - **제한사항 기록**: 장기 보관용 영수증 EXIF GPS 메타데이터 제거(stripping) 및 법적 보존기간 자동 파기 배치는 MVP 범위 외로 정책 확정 후 후속 구현 필요.

---

## 5. 결제·환급 테스트 모드 가드 & 원격 거래 대사

- **실거래 차단**:
  - `PAYMENT_MODE`: `disabled` 또는 `test`만 허용, `live` 즉시 차단 (`getPaymentMode()`).
  - `TOSS_TEST_SECRET_KEY` / `NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY`: `live_` 접두사 즉시 차단 (`assertPaymentTestModeAllowed()`, `toss-sdk.ts`, `cloudbuild.yaml`).
- **원격 DB 결제·환급 최종 대사 (읽기 전용 조회, 2026-11-21)**:
  - 테스트 거래 `hm_ord_1795267328427_ca1a7bb67acd` (1,000원):
    - `payment_orders`: `status='approved'`, `payment_mode='test'`, `amount_krw=1000`, `has_pk=true`, `approved_at=2026-11-21 13:22:50.912523+00` (설계상 `approved` 불변 유지).
    - `access_sessions`: `status='code_revealed'`, `authorized_at=2026-11-21 13:22:50.912523+00`, `code_revealed_at=2026-11-21 13:24:42.808834+00`.
    - `pin_reveal_audits`: `success` 3건(`code_version=1`), `visit_confirmations`: `user / success` 1건.
    - `receipt_submissions`: `submission_status='approved'`, `store_name_confirmed='진미통닭'`, `purchase_amount_krw=50000`.
    - `receipt_review_audits`: `decision='approved'` 1건.
    - `payment_refunds`: `status='succeeded'`, `amount_krw=1000`, `has_cancel_id=true`, `failure_reason=null`, `requested_at=2026-11-21 13:31:39.203511+00`, `completed_at=2026-11-21 13:31:40+00`.
    - `audit_logs`: `receipt_review_approved` → `refund_requested` → `refund_toss_cancel_requested` → `refund_toss_cancel_succeeded` 4건 기록(`after_keys`에 비밀키/PIN/결제키 없음).
  - **판정**: Toss 승인 `DONE` 및 전액 취소 `CANCELED`(1,000원, 잔액 0원) 결과와 원격 DB 최종 상태 완전 일치.

---

## 6. 비밀정보 유출 점검 (Secret Leak Check)

- **Git 추적 파일**: `.env.local`, `local-data/` 미포함 (`.env.example`만 추적).
- **클라이언트 빌드 번들(`.next/static`)**: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, `TOSS_TEST_SECRET_KEY`, `PIN_ENCRYPTION_KEY`, `test_sk_`, `test_gsk_`, `sb_secret_`, `live_*` 문자열 **0건**.
- **클라이언트 컴포넌트(`src/components/**`)**: 서버 전용 비밀 환경변수 참조 **0건**.
- **원격 `audit_logs`**: `after_keys` 검사 결과 `provider_payment_key`, `provider_cancel_id`, `idempotency_key`, PIN, 카드정보 미포함 확인.

---

## 7. 선택적 행동 분석 동의·철회 및 발견 사항 정비 현황

| ID | 상태 | 현상 및 조치 내역 |
|---|---|---|
| ANA-P01 (동의/철회·분리) | **PASS** | 선택적 행동 분석 3상태 동의(`undecided`/`accepted`/`declined`, 기본값 `undecided`), `/` 및 공개 경로 첫 방문 전체 화면형 동의 UI(`휴지맵 시작하기` + 일반 이용자 관점 접이식 4항목·상세 개인정보 처리 안내·내부 DB/API/이벤트 식별자 비노출·`hm_consent_pref` SSR 깜빡임 최소화)·메뉴 `이용 통계 설정` 모달 구현, 별도 `/privacy`·`/settings/privacy` 화면 제거 및 `/map?analyticsDetails=1`·`/map?analyticsSettings=1` 리다이렉트, 로그인/로그아웃 시 `hm_session_id`/`hm_session_token` 회전(비로그인↔로그인 미연결), 서버 `SESSION_OWNERSHIP_MISMATCH`·`CONSENT_OWNERSHIP_MISMATCH`·철회 시 `403 ANALYTICS_CONSENT_WITHDRAWN` 검증 (`analytics_privacy_complete.test.tsx` 19/19 + `test_events_ui_hooks_mobile.mjs` PASS) |
| SEC-F01 (A19 정책) | **CLOSED (의도적 제거)** | A19 `TravelSurveyBanner` 및 `landing_view`는 복원하지 않기로 확정하고 6개 선택적 행동 이벤트(`map_loaded`, `restroom_marker_clicked`, `restroom_card_viewed`, `restroom_detail_opened`, `directions_clicked`, `payment_button_clicked`)로 범위 한정 |
| OPS-F02 (테스트 환경) | **Low** | `tests/integration/auth_schema.test.ts`는 `.env.local`이 로컬 Supabase(`127.0.0.1:54321`)를 가리킬 때 원격 URL 정규식 테스트 1건이 환경 차이로 실패 (단위/회귀 55파일 822건은 별도 전원 PASS) |
| OPS-F03 (E2E 갱신) | **RESOLVED** | `test_business_ui_mobile.mjs`, `test_events_ui_hooks_mobile.mjs`, `test_pmf_dashboard_mobile.mjs`, `test_restroom_photos_mobile.mjs`를 최신 UX·동의 팝업·필터·탭 명세로 갱신 및 Chrome E2E 15종 PASS 확인 (참고: 구 비교용 스크립트 `verify_ui_ux_v2.mjs`는 UI/UX 3차 FIX-06 이후 `/my/receipts?accessSessionId=...` 단일 이용권 모드에서 탭을 숨기도록 변경되어 은퇴 처리 — `test_receipt_customer_ui_mobile.mjs`가 현행 영수증 UX 검증 담당) |
| OPS-F04 (법률·운영정책) | **Info (승인 대기)** | `docs/11_DECISIONS.md` 미확정 항목(실운영 보증금·영수증 기한·최소구매금액·EXIF GPS 제거·보존기간·`/privacy` 법률 검토·PG 심사) 및 `rulesComplete:false` 유지 — 상용 전환 전 필수 확정 필요 |
