# 04 — HTTP API contracts (Next.js `/api/v1`)

All requests/responses JSON except multipart uploads and file streaming. `application/json` errors: `{ error: { code, message }, requestId }`. Server validation via Zod. HTTP status 400 input, 401 auth, 403 owner/role, 404 not found, 409 collision/idempotency, 422 state-policy, 429 abuse, 500 error. `requestId` random. Don't expose secrets/PII. All writes authenticated except events and registration? Registration merchant auth required. CSRF protection on cookie-authenticated mutations, allowed Origin and rate limits. GET requests never change DB transactional state.

## Public catalog and PMF

| Route | Auth | Input | Response/action |
|---|---|---|---|
| GET `/restrooms` | guest | `bbox=south,west,north,east&type=all/public/partner&limit=100` | published, approved and non-secret public fields only; validate bbox max span and cap |
| GET `/restrooms/:id` | guest | id UUID | detail, hours, current active policy public info, approved photos; **no PIN** |
| GET `/businesses/:id` | guest | id UUID | approved public business info only |
| POST `/events` | guest | `clientEventId, sessionId, browserId, eventName, eventVersion, context, occurredAt` | accepted/dedup; server determines is_test; allowed event name list, payload limit and rate limit |
| POST `/sessions` | guest | browserId, UTM, consent state, landingPath | sessionId; server records session and campaign |
| PATCH `/sessions/:id/travel-answer` | guest | `travelingNow: boolean` | persisted response event; link to browser session, server-generated event record |
| GET `/health` | guest | none | runtime ready & integrations configured (no secret values) |

## Merchant & admin

| Route | Auth | Input | Response/action |
|---|---|---|---|
| POST `/merchant/businesses` | merchant | name/category/address/coords/contact | create `draft` business + ownership membership; no public exposure |
| PATCH `/merchant/businesses/:id` | merchant owner | editable non-approval fields | update own draft; approved changes can reset review as specified |
| POST `/merchant/businesses/:id/submit` | merchant owner | none | `pending`; required fields validation |
| POST `/merchant/restrooms` | merchant owner | businessId, name, location, accessMethod, hours, photos metadata | partner restroom draft, pending owner-verified business |
| PATCH `/merchant/restrooms/:id` | merchant owner | draft fields/conditions | update with policy versioning; no retroactive change to paid access |
| POST `/admin/businesses/:id/decision` | admin | approve/reject, reason | verify business evidence/approval, audit |
| POST `/admin/restrooms/:id/decision` | admin | publish/reject/suspend, reason | approval and audit |
| GET `/admin/leads` / POST `/admin/leads` | admin | pagination/contact form | 50-contact list; independent from business users |
| POST `/admin/leads/:id/contacts` | admin | time/channel/result/notes | record contact attempt |

## Payments (test only)

| Route | Auth | Input | Response/action |
|---|---|---|---|
| POST `/payments/orders` | customer + test-user entitlement | `{restroomId, idempotencyKey}` | server chooses active policy & amount, creates access session + order. `orderId`, amount, test client key public only |
| POST `/payments/confirm` | same customer | `{orderId, paymentKey, amount}` | server checks owner/order amount, calls Toss `/v1/payments/confirm` with secret, stores `approved`, issues authorized access; only `test` mode. Repeat-safe |
| GET `/payments/orders/:id` | order owner/admin | none | current test order status, never expose providerPaymentKey |
| GET `/payment/return` | browser | success/failure params | **only display**; server `/payments/confirm` required before access granted |

## PIN / Access

| Route | Auth | Input | Response/action |
|---|---|---|---|
| POST `/merchant/restrooms/:id/pin` | verified business owner/admin | `{pin}` | AES-256-GCM encrypt, rotate active code; return version only. Require explicit approved test facility; never echo pin |
| GET `/access/:id` | access owner/admin | none | access details, expiry/status without PIN |
| POST `/access/:id/reveal-pin` | access owner + valid approved transaction | empty | verify payment confirmed by server, scope, time, restroom method, PIN; audit; return `{pin, expiresAt}` no-store. Rate limit |
| POST `/access/:id/visit-confirmation` | owner or authorized merchant | `{usageStatus, reason?}` | record assertion and source, not definitive physical evidence |

## Receipt manual review & refund

| Route | Auth | Input | Response/action |
|---|---|---|---|
| POST `/receipts/upload-intent` | access owner | `{accessSessionId, mimeType, size}` | validate test payment approved, window, allowed type/size; single-use signed upload path; private bucket |
| POST `/receipts` | access owner | `{accessSessionId, uploadedPath, mimeType, size, clientSubmissionId}` | DB receipt submitted, pending; verify owned file path; cannot self-approve |
| GET `/my/receipts` | customer | pagination | own receipt+review/refund status, no other customer files |
| GET `/admin/receipts` | admin | status/page | pending queue |
| GET `/admin/receipts/:id/image` | admin | receiptId | short-lived signed file access, audit; no public URL |
| POST `/admin/receipts/:id/decision` | admin | `{decision:approved/rejected/resubmission_requested,reason,confirmedStore?,confirmedPurchaseAt?,confirmedAmount?}` | validates receipt, merchant/time/purchase check and dupes; persists audit, review decision. NO auto refund from browser |
| POST `/admin/refunds/:paymentOrderId/request` | admin | `{receiptSubmissionId,idempotencyKey}` | only approved review and confirmed original payment; server starts/records test cancellation; duplicate safe |
| GET `/admin/refunds` | admin | filters | test refund state including error/retry |

## Analytics

GET `/admin/analytics/pmf?experimentKey=pmf_r1` admin-only: return separate H1/H2/H5 numerators, denominators, raw eligible counts, observed time range, exclusions and source rules version. If canonical 19 rules not loaded return `rulesComplete:false` and explain, never claim final certified pass.

## API implementation patterns

- `GET` routes no side effects. `POST` with duplicate key returns prior result if same parameters, 409 if conflicting payload.
- All writes persist `audit_logs` if sensitive; client events are telemetry only.
- Runtime endpoints check `PAYMENT_MODE=test` AND secure server feature gate AND test user/approved facility. Disable if keys absent; fail closed.
- Browser never sends/chooses trusted payment amount, admin role, merchant owner ID, or receipt-approved status.

