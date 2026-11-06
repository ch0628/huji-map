# HujiMap — IMPLEMENTATION_STATUS

상태: `NOT_STARTED` / `PASS` / `BLOCKED` / `FAIL`. 작업 하나가 PASS되지 않은 상태에서 다음 작업을 자동 실행하지 않는다. 이 문서는 Antigravity가 각 작업 후 갱신한다.

| 작업 | 상태 | 변경 파일·검증 결과 |
|---|---|---|
| 00 `workspace_inventory` | PASS | 파일: `.gitignore` 신규 생성. 런타임: Node v24.8.0, npm 11.6.0, git 2.50.1. 기존 문서(docs, tasks, setup) 보존 확인. 앱 코드 미작성 상태 확인. |
| 01 `nextjs_scaffold` | PASS | 파일: `package.json`, `tsconfig.json`, `next.config.mjs`, `postcss.config.mjs`, `tailwind.config.ts`, `eslint.config.mjs`, `next-env.d.ts`, `.env.example`, `.gitignore`, `src/app/**`, `src/components/layout/**`. 검증: `npm run typecheck` (통과), `npm run lint` (통과), `npm run build` (통과: `/`, `/map` 정적 페이지 생성 확인), `next start` (서버 정상 기동 확인). |
| 02 `quality_setup` | PASS | 파일: `vitest.config.mts` (Playwright E2E 제외 및 단위 테스트 경로 격리 설정), `tests/unit/smoke.test.ts` (보증금 계산, PMF 이벤트 키, 런너 스모크 테스트 3건), `playwright.config.ts`, `tests/e2e/smoke.spec.ts`. 검증: `npm run lint` (통과), `npm run typecheck` (통과), `npm run test` (3/3 통과), `npm run build` (통과). Playwright: 설정 및 smoke spec 구성 완료(`npx playwright test --list` 확인), 로컬 ms-playwright 브라우저 바이너리 미설치로 E2E 실브라우저 실행은 생략. |
| 03 `auth_schema` | PASS | 파일: `package.json`, `package-lock.json`, `supabase/migrations/20261106000000_auth_schema.sql`, `src/lib/db/types.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/auth.ts`, `tests/integration/auth_schema.test.ts`, `tests/integration/auth_schema.vitest.config.mts` (`ambient.d.ts` 제거 및 공식 SDK 대체 완료). SDK: `@supabase/supabase-js@2.119.0`, `@supabase/ssr@0.12.7` 실제 설치 및 공식 타입 연동 완료. 검증: `npm ls @supabase/supabase-js @supabase/ssr` (정상), `npm run lint` (통과), `npm run typecheck` (통과), `npm run test` (통과, 3/3), `npx vitest run --config tests/integration/auth_schema.vitest.config.mts` (통과, 15/15: SDK 클라이언트 생성, 5개 테이블 제약조건, RLS, customer 기본 부여, admin 자가할당 차단 등), `npm run build` (통과). 원격 DB: 실제 Supabase 프로젝트 연결 키 미제공으로 원격 DB 반영은 BLOCKED 유지. |
| 04 `auth_ui` | NOT_STARTED | — |
| 05 `lead_tracking` | NOT_STARTED | — |
| 06 `business_backend` | NOT_STARTED | — |
| 07 `business_ui` | NOT_STARTED | — |
| 08 `business_approval` | NOT_STARTED | — |
| 09 `restroom_schema` | NOT_STARTED | — |
| 10 `catalog_api` | NOT_STARTED | — |
| 11 `public_import` | NOT_STARTED | — |
| 12 `restroom_merchant_api` | NOT_STARTED | — |
| 13 `restroom_merchant_ui` | NOT_STARTED | — |
| 14 `restroom_admin_review` | NOT_STARTED | — |
| 15 `map_provider` | NOT_STARTED | — |
| 16 `map_discovery_ui` | NOT_STARTED | — |
| 17 `events_backend` | NOT_STARTED | — |
| 18 `events_ui_hooks` | NOT_STARTED | — |
| 19 `pmf_dashboard` | NOT_STARTED | — |
| 20 `payment_schema` | NOT_STARTED | — |
| 21 `toss_server` | NOT_STARTED | — |
| 22 `toss_checkout_ui` | NOT_STARTED | — |
| 23 `pin_storage` | NOT_STARTED | — |
| 24 `pin_reveal` | NOT_STARTED | — |
| 25 `pin_ui` | NOT_STARTED | — |
| 26 `receipt_backend` | NOT_STARTED | — |
| 27 `receipt_customer_ui` | NOT_STARTED | — |
| 28 `manual_review_backend` | NOT_STARTED | — |
| 29 `manual_review_ui` | NOT_STARTED | — |
| 30 `refund_server` | NOT_STARTED | — |
| 31 `refund_admin_ui` | NOT_STARTED | — |
| 32 `integration_deploy` | NOT_STARTED | — |
