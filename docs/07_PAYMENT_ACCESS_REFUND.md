# 07 — Payment / access / PIN / manual receipt / refund

## Test-only rule

`PAYMENT_MODE=disabled` default. Only `test` permitted by code. Test keys `test_...` alone. No `live` mode. If credential absent, render '결제 기능 준비 중' with event. Do not create fake successful payments/access. Tests may use mocked PG in *automated test runtime* only and clearly label the mocks.

## A. Test order & confirmation

1. Verified authenticated test customer chooses a published approved PARTNER restroom with active `test_deposit` policy, amount > 0, approved consent.
2. Server creates `access_sessions(status=created,policy_id,expires_at)` and `payment_orders(status=created,order_id,amount_krw,test)` in single DB transaction or safe compensated operation; idempotency_key prevents duplicate.
3. Browser Toss SDK v2 checkout using public **test** client key, returns orderId/paymentKey/amount.
4. Server fetches order by owner/orderId, checks amount/status/expiry/idempotency, calls Toss confirm API with test secret, re-verifies response; marks order approved and access authorized. Failed confirm -> no access.
5. Repeat confirm with same ID returns prior result, conflicting params reject. Every sensitive state change audit.

## B. Access and PIN

- Approved `access_sessions` authorizes only restroom in that access. Valid time must be checked server-side. QR/external link cannot bypass.
- For `access_method=pin`, server validates authorized access + successful stored PG order + not expired + restroom approved + no emergency closure, then decrypts only current valid merchant PIN from encrypted store and returns once per explicit request. `Cache-Control:no-store` and no secret in app state persistence, logs or analytics; audit result.
- For `ask_staff`, display access ticket with random code/QR proof, not secret door code.
- Actual PIN once disclosed may be shared. System does not claim physical one-use enforcement without smartlock. Trial requires real merchant approval.
- PIN encrypted AES-256-GCM with `PIN_ENCRYPTION_KEY` in server env only; random nonce per record. Merchant updates via authenticated verified-owner route; store version/rotation and audit.

## C. Manual receipt review

1. Customer with authorized access uploads image JPG/PNG/WebP <=10MB to **private** Storage at server-generated path.
2. Server verifies owner, file metadata and time policy, writes receipt submission `submitted` (no OCR).
3. Admin reviews image with reference merchant name, registration number if available, order time/policy, photo repeat check, manual purchase amount/time.
4. Admin choices: approve / reject / request resubmission. Must input reason; audit append-only. Users cannot set review statuses.
5. An approved receipt grants **refund eligibility**, not the same as completed cancellation. Real-world validation of purchase reversal/fraud is limited without POS integration.

## D. Test cancellation/refund

- Admin triggers refund for an approved submission linked to test approved order; create one `payment_refunds` record per order with idempotency key; no partial refund in MVP.
- Server calls Toss TEST cancellation API; captures provider success/failure (full amount). Mark `succeeded` only upon verified provider success. Timeout -> keep uncertain/processing and reconcile before retry, do NOT blindly duplicate. Cancel failure -> show recoverable error.
- No receipt or valid purchase by deadline -> original test payment remains approved. No extra charge. Pending review at deadline does not auto reject.
- Account/order state for end user: `결제 완료` → `영수증 검토 중` → `환급 승인` → `테스트 환급 완료` vs `환급 불가`; honest messages.

## E. Policy undecided / default test fixtures

- `deposit_amount_krw=1000` test only, `receipt_window_hours=24` test only, `min_purchase_krw=1` test fixture; **business contract terms have NOT been decided**. Avoid publishing these as binding policy to real visitors.
- Deposit ultimate beneficiary, return/chargeback conditions, legal/PG acceptance, merchant consent and customer disclosure require explicit decision before production.
- Emergency closure/no access must expose support and operator refund handling; no access rights at a closed/disabled partner.

## F. Invariants and tests

- Never issue authorized access on client-reported successful payment alone.
- Never expose PIN in any public restroom response, logs or snapshots.
- No manual receipt approval by customer or merchant unless explicit future policy revision.
- One successful payment per access session, one full refund per successful payment, duplicate-safe.
- Payment amount snapshot cannot change after order created even if merchant edits policy.
- Test payment and real payment data must not share live key or ambiguous display.

