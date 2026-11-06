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

- Default no tracking of precise live GPS in events. `browser_id` random pseudonym; treat identifiers as potentially personal data; consent/disclosure policy in Korean/English draft subject to review.
- Photo, proof/registration number, phone and notes admin/merchant only. Return explicit public allowlist.
- User account deletion and retention periods require policy; do not silently purge financial/refund audit before legal review.
- Public restroom unknown open status should be shown as '확인되지 않음'; no guarantee location implies access.

## Ops

- Monitor import age, PG tests, pin-reveal denied/failed, manual receipts pending, refund failed, event ingest rate. Use server logs with requestId and redaction; never full request body for sensitive routes.
- Public dataset: record source/license and import run. Sync failure doesn't erase last verified data; UI shows verification date.
- Feature flags are *not* security: always check permissions in server API.
- Test failure requires stopping task and writing blocker; no destructive resets of shared DB without approval.

