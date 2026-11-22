# HUJIMAP — MVP 배포 및 운영 체크리스트

기준일: 2026-11-22  
대상: 로컬 작업 트리 (Git push 대기), Cloud Run `hujimap-staging` (`asia-northeast3`), 원격 Supabase `wddnbycimcixskemssct`  
참고 가이드: [docs/deployment/gcp_cloud_run.md](file:///c:/Users/ASUS/Documents/Antigravity/toilet/docs/deployment/gcp_cloud_run.md), [cloudbuild.yaml](file:///c:/Users/ASUS/Documents/Antigravity/toilet/cloudbuild.yaml), [docs/10_CONFIG_AND_BLOCKERS.md](file:///c:/Users/ASUS/Documents/Antigravity/toilet/docs/10_CONFIG_AND_BLOCKERS.md)

---

## 1. 코드·품질 게이트

- [x] `npm run typecheck` (`tsc --noEmit`) — 오류 0건
- [x] `npm run lint` (`eslint .`) — 오류 0건 (기존 미사용 변수 경고 1건: `tests/e2e/test_partner_info_pin_e2e.mjs`)
- [x] `npx vitest run --maxWorkers=2` — **55개 파일 / 822개 테스트 전원 PASS** (`analytics_privacy_complete` 19/19, `pmf_analytics` 17/17, `events_backend` 26/26, `receipt_customer_server` 3/3 포함)
- [x] `npm run build` (`next build --webpack`, standalone) — 정적 41페이지 및 전체 API 라우트(`/api/v1/privacy/consent`, `/privacy`→`/map?analyticsDetails=1`, `/settings/privacy`→`/map?analyticsSettings=1` 포함; 독립 개인정보 페이지 제거) 빌드 PASS
- [x] PGlite·로컬 PostgreSQL 마이그레이션·동시성·롤백 검증 PASS (`test_pglite_task06_migrations.mjs`, `test_real_pg_task06_migrations.mjs`, `verify_task06_migrations_rollback.sql`, `test_pglite_receipt_backend.mjs`, `test_pglite_events_backend.mjs`, `test_pglite_merchant_operations.mjs`, `test_receipt_concurrency.mjs`)
- [x] Google Chrome E2E 15종 PASS (`test_events_ui_hooks_mobile`, `test_pmf_dashboard_mobile`, `test_auth_navigation_guest_mobile`, `test_map_discovery_mobile`, `test_business_ui_mobile`, `test_restroom_merchant_ui_mobile`, `test_payment_checkout_mobile`, `test_access_pin_ui_mobile`, `test_receipt_customer_ui_mobile`, `test_admin_receipt_review_mobile`, `test_admin_refunds_mobile`, `test_admin_business_approval_mobile`, `test_admin_restroom_review_mobile`, `test_restroom_photos_mobile`, `verify_ui_ux_v1 --mode=after`; 구 비교 스크립트 `verify_ui_ux_v2.mjs`는 FIX-06 이후 `?accessSessionId` 단일 이용권 화면에서 탭이 숨겨지므로 `test_receipt_customer_ui_mobile.mjs`로 대체·은퇴)
- [ ] `tests/integration/auth_schema.test.ts` — 별도 Vitest 설정(`auth_schema.vitest.config.mts`)이며 `.env.local`의 로컬 URL 사용 시 원격 URL 정규식 1건 불일치 (이전 TASK 32 기록 기준)

---

## 2. 원격 Supabase 상태 점검 (`wddnbycimcixskemssct`)

- [x] 마이그레이션 동기화: `npx supabase migration list --remote` — 로컬·원격 **22/22** 일치 (`20261106000000` ~ `20261123010000`, 신규 `20261123000000_receipt_reject_resubmission_guard.sql`, `20261123010000_prevent_duplicate_restroom_policy.sql` 원격 반영 완료)
- [x] 사후 카탈로그 검증: `create_merchant_restroom_policy` (`has_policy_guard=true`, `search_path=public, pg_temp`), `validate_receipt_upload_intent` (`has_reject_guard=true`, `search_path=pg_catalog, pg_temp`) 및 권한/RLS 확인
- [x] 기존 데이터 보존 확인: `businesses_cnt=2`, `policies_cnt=514`, `receipts_cnt=2`, `restrooms_cnt=506` (수원시 공공화장실 `502`건 등 기존 데이터 손실 0건)
- [x] `public` 스키마 전 테이블 RLS 활성화 및 Private Storage 버킷(`receipts`, `restroom-photos`, `public = false`, 10MB, JPG/PNG/WebP) 유지

---

## 3. GCP Cloud Run 스테이징 배포 준비 (`hujimap-staging`)

- [x] `cloudbuild.yaml` 보안 가드: `_PAYMENT_MODE` `disabled`/`test`만 허용(`live` 차단, 기본 `disabled` 유지), `_NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY` `live_` 차단
- [x] `_NEXT_PUBLIC_ANALYTICS_ENABLED: "true"` 스테이징 설정 반영 (`cloudbuild.yaml`) — `/` 및 공개 경로 첫 방문 전체 화면형 3상태 동의 UI(`휴지맵 시작하기`, `undecided` 기본값 · 접이식 4항목 + 상세 개인정보 처리 안내 · `hm_consent_pref` 기반 깜빡임 최소화)·메뉴 `이용 통계 설정` 모달 철회·별도 `/privacy`/`/settings/privacy` 페이지 제거·비로그인/로그인 분리(`is_authenticated`) 검증 완료 후 활성화 준비
- [ ] **Git push 및 Cloud Build 배포 대기**: 위 `cloudbuild.yaml` 및 최신 UI/분석/API 변경사항은 사용자가 Git commit/push 후 Cloud Build(`hujimap-main-deploy`)가 완료되어야 실제 `hujimap-staging`에 반영됨 (현재 스테이징 미반영 상태 구분)
- [x] 런타임 비밀키 Secret Manager 분리: `hujimap-supabase-secret-key`, `hujimap-toss-test-secret-key`, `hujimap-pin-encryption-key`

---

## 4. 배포 후 확인 및 상용 전환 전 남은 항목

- [x] **A19 (`TravelSurveyBanner`) 영구 제거 확정**: H2 여행 설문 및 `landing_view`는 복원하지 않고, 6개 선택적 행동 이벤트(3상태 동의 기본값 `undecided`, `/`·공개 경로 첫 방문 전체 화면형 UI `휴지맵 시작하기` 및 `이용 통계 설정` 모달)로 대체 확정
- [ ] **배포 후 스테이징 확인 (`POST-PUSH`)**: Git push & Cloud Build 완료 후 `/`·`/map` 첫 방문 전체 화면형 동의 UI(접이식 4항목 및 상세 개인정보 처리 안내), 메뉴 `이용 통계 설정` 모달(`/privacy`·`/settings/privacy` 리다이렉트), `/map` 동의 전 미전송/동의 후 6개 이벤트(비로그인·로그인 분리), `/admin/analytics/pmf` `전체`/`비로그인`/`로그인` 필터 실집계 확인
- [ ] **상용(Production) 전환 전 필수 선결 (MVP 이후 범위)**:
  - 수집·보유기간·외부 처리업체 고지 및 법적 문구 법률 검토 완료
  - Toss 실거래 심사 및 법무/약관/환급 예외·정산 정책(`docs/11_DECISIONS.md`) 확정
  - 19개 PMF 세부 규칙 원문 반영 (`rulesComplete: true` 전환 전까지 잠정 집계 유지)
  - 영수증 EXIF GPS 제거 및 보존·파기 정책 구현
  - 전국 공공화장실 데이터(`51,264`건) 원격 이전 여부 별도 승인
  - 실운영 시 `test_` 키·테스트 데이터 분리 및 `live_` 전환 별도 승인
