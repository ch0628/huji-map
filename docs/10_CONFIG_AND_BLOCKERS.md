# 10 — Environment setup / unavoidable user authorization

## `.env.example` required (never commit `.env.local`)

```
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_KAKAO_MAP_JS_KEY=
PAYMENT_MODE=disabled
NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY=
TOSS_TEST_SECRET_KEY=
PIN_ENCRYPTION_KEY_BASE64=
NEXT_PUBLIC_ANALYTICS_ENABLED=false
```

Do not use a Toss live key. A fresh 32-byte random AES key for PIN can be generated locally for test by the agent (not checked into Git); but the runtime secret must be stored in `.env.local`, secrets manager in deployed server; agents must not print it.

## User action strictly needed at some point

- Supabase: create project, sign in, get project URL/anon/publishable key, service-role secret, approve migrations/Storage. Agent can guide but cannot mint access to user's provider account without their authorization.
- Kakao Developers: create app, add Web domain `http://localhost:3000`, deployed domain later; enable Kakao Maps JS SDK and obtain JS key.
- Toss Payments developer: test client + secret keys; payment test mode. Real merchant onboarding/contract not needed to **code** test mode, but account/keys required to truly execute provider integration.
- Vercel: user grants deployment account/repository authorization, configures secret envs; agent performs steps if already authenticated.
- Actual merchant: explicit permission before publishing lock PIN or real store listing; do not create fictitious live businesses.

## Step-specific fallbacks

- Keys absent: build type-safe adapters, compile locally, unit test with mocks marked **TEST**, but never claim live connectivity. Mark external integration test BLOCKED.
- Kakao map missing key: show `지도 연동 설정 필요`. Don't use a fake map labelled real.
- Toss key missing: checkout disabled and `결제 기능 준비 중`; never issue a real access session via fake confirmation.
- Supabase credentials missing: local schema migrations and mock-only unit tests possible; remote auth/database tests BLOCKED.
- No merchant PIN approval: test with synthetic TEST PIN in isolated test fixture only, never reveal production PIN.
- Behavioral analytics (`NEXT_PUBLIC_ANALYTICS_ENABLED`):
  - Local `.env.example` and `Dockerfile` keep safe default `false`.
  - Next.js inlines `NEXT_PUBLIC_ANALYTICS_ENABLED` at **build time** (`Dockerfile` `--build-arg`, `cloudbuild.yaml`). Server APIs (`/api/v1/events`, `/api/v1/sessions`) also gate on runtime env (`403 ANALYTICS_DISABLED` when not `"true"`).
  - `cloudbuild.yaml` sets `_NEXT_PUBLIC_ANALYTICS_ENABLED: "true"` for staging after first-visit `/` & public-route full-screen tri-state consent UI (`휴지맵 시작하기`, 4 plain-Korean accordions + expandable privacy details, `undecided` default, SSR flash prevention via `hm_consent_pref`), `이용 통계 설정` modal withdrawal, standalone `/privacy` & `/settings/privacy` redirect removal, and guest/authenticated analytics separation passed verification; actual staging activation takes effect only after Git push + Cloud Build deployment completes. Live/production payment remains `disabled` / non-live.
  - Legal review remains pending for formal retention periods and statutory privacy disclosures before general user live operation.

## Useful official docs

- Antigravity workspace rules: https://antigravity.google/docs/rules/
- Supabase Next.js SSR: https://supabase.com/docs/guides/auth/server-side
- Toss test payment widget: https://docs.tosspayments.com/en/integration-widget
- Toss API test credentials: https://docs.tosspayments.com/en/api-guide
- Kakao map: https://apis.map.kakao.com/web/guide/

