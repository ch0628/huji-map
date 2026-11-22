# 08 — Security / data privacy / operations

## Security boundaries

- Auth: `@supabase/ssr` cookies, server `getUser` not untrusted JWT-only display; merchant membership verified per resource; admin role server controlled.
- DB: RLS enabled on all tables; default deny client direct SQL. Application DB via server only. Use service role key exclusively server process; explicit least-privilege response shapes. Avoid `select('*')` in public APIs.
- Secrets: `.env.local` ignored; `.env.example` variable names only. Secrets cannot appear in browser/stack trace/`event_logs`/audit diffs/Git. Production/test separate projects recommended.
- PIN: authenticated merchant may rotate PIN after ownership verified; encrypted at rest (AES-256-GCM) with random IV. Server decrypt only eligible access. Log status only. No PIN in URL, SSR props, Next.js client bundle, telemetry or caching.
- Receipt: private bucket, signed upload and short-lived read URL only for submitter/admin. Verify MIME by magic bytes where feasible; 10MB max, whitelist JPG/PNG/WebP, strip EXIF GPS for long-term retention, retention policy to be legally specified.
- Admin: records all merchant approval/receipt decisions/refund requests in append-only audit trail. Admin bootstrap requires explicit approved Auth UUID; no public admin registration.
- Test mode: actual live keys prohibited. `PAYMENT_MODE=disabled` default. Testing that reveals real merchant PIN requires authorized test users and merchant agreement. No fake payment success.
- Abuse: rate limiting on events, login, PIN reveal, uploads, payment; duplicate idempotency keys; CSRF/origin checks for cookie actions; backend timestamp as source of truth for eligibility.

## Privacy and safety

- Optional behavioral analytics consent uses tri-state status (`undecided` | `accepted` | `declined`, default **`undecided`**) and never treats `undecided`, ESC dismissal, or required signup/payment agreements as analytics consent. Consent from an older `PRIVACY_POLICY_VERSION` is invalidated back to `undecided`. A non-identifying UI preference cookie (`hm_consent_pref`, storing only `policyVersion:accepted|declined`) prevents first-visit SSR flash on `/`, `/map`, and `/restrooms/*` for both first-time and returning users without storing tracking IDs.
- Before explicit acceptance via the full-screen first-visit consent UI (`AnalyticsConsentModalHost` — `휴지맵 시작하기`, 4 plain-Korean accordions + expandable detailed privacy notice) or user-menu `이용 통계 설정` modal (`PrivacySettingsClient` -> `POST /api/v1/privacy/consent` -> `consent_records`), `hm_browser_id` and `visitor_sessions` are NOT created/stored and client event calls are blocked. Also `NEXT_PUBLIC_ANALYTICS_ENABLED === "true"` is required for any optional event/session transmission or `hm_browser_id` creation.
- Standalone `/privacy` and `/settings/privacy` pages are retired and redirect server-side to `/map?analyticsDetails=1` and `/map?analyticsSettings=1` respectively (old bookmark/link compatibility without separate privacy document pages).
- Auth boundary & ownership guards: both unauthenticated visitors (`user_id = NULL`) and authenticated users (`user_id != NULL`) may opt in cleanly, separated server-side via `getUser()`. `syncAnalyticsAuthBoundary` rotates `hm_session_id`/`hm_session_token` across login/logout without mutating consent; server rejects writing to anonymous `visitor_sessions` from an authenticated session (`403 SESSION_OWNERSHIP_MISMATCH`), verifies `hm_session_token` when present on anonymous sessions, and enforces `hm_consent_bid` cookie / DB `user_id` ownership on `/api/v1/privacy/consent` (`403 CONSENT_OWNERSHIP_MISMATCH`).
- Upon decline/withdrawal in `이용 통계 설정`, client removes `hm_browser_id`, `hm_session_id`, `hm_session_token`, expires `hm_session_token` and `hm_consent_bid` cookies, records withdrawal in `consent_records`, and server rejects further ingestion (`403 ANALYTICS_CONSENT_WITHDRAWN`) — while keeping required payment, refund, and security audit logs separate.
- Notice disclosures (`PRIVACY_POLICY_VERSION = "2026-11-22"`): basic accordions avoid internal DB/API/event identifier names while the expandable `상세 개인정보 처리 안내` inside `개인정보 처리 안내` discloses processing purposes/items (including browser/session pseudonyms, referrer/UTM, device type, guest/authenticated separation), retention/destruction criteria, external processors (Kakao Maps, Toss Payments, cloud DB/hosting), and user rights/withdrawal instructions. Legal review of formal statutory retention schedule and external disclosures remains required prior to public launch.
- Default no tracking of precise live GPS in events. `browser_id` random pseudonym; treat identifiers as potentially personal data.
- Photo, proof/registration number, phone and notes admin/merchant only. Return explicit public allowlist.
- User account deletion and retention periods require policy; do not silently purge financial/refund audit before legal review.
- Public restroom unknown open status should be shown as '확인되지 않음'; no guarantee location implies access.
- DB migrations synced at 22/22 including `20261123000000` (rejected receipt resubmission guard) and `20261123010000` (duplicate unchanged restroom policy guard).

## Ops

- Monitor import age, PG tests, pin-reveal denied/failed, manual receipts pending, refund failed, event ingest rate. Use server logs with requestId and redaction; never full request body for sensitive routes.
- Public dataset: record source/license and import run. Sync failure doesn't erase last verified data; UI shows verification date.
- Feature flags are *not* security: always check permissions in server API.
- Test failure requires stopping task and writing blocker; no destructive resets of shared DB without approval.

