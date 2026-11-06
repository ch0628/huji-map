# 11 — Decisions: fixed vs undecided

## FIXED; do not ask user again unless contradictions emerge

- Korea/suwon early service. Mobile-first web. Korean UI.
- Public restroom = free + directions; partner = directions + deposit before access.
- Partner merchant onboarding free; no subscription charging.
- Real user money not collected during development; Toss `test_` keys ONLY.
- No custom test credits.
- Receipt image submission + **manual administrator review**, OCR excluded.
- PIN from approved merchant, encrypted, revealed only after approved/verified successful test payment + valid access session.
- Native map via Kakao SDK with adapter; preserve ability to switch to Google Maps.
- Event tracking separates behavior (click) vs server-state outcomes (approval/refund).
- High-priority H1/H2/H5 browser-level counts; H3/H4 later.

## NOT YET DECIDED: configurable only, never pretend production policy fixed

- Deposit amount per restroom; **demo/test default 1000 KRW** only in test mode, prominently labelled.
- Receipt submission window; **test default 24 hours** as temporary QA fixture, not production policy.
- Minimum purchase amount; QA default >0 for tests; do not claim actual business rule.
- Deposit beneficiary/settlement if no purchase; subject to PG/legal/merchant agreements.
- Refund exceptions for closed toilet, PIN malfunction, accessibility; user must approve before live.
- Whether verified business can change PIN alone or require administrator second check; default owner+admin-verified business.
- Merchant subscription pricing/start date, actual billing deferred.
- Exact event definitions in the previously agreed 19 detailed PMF rules: obtain canonical source before calling the metrics certified; the known H1/H2/H5 threshold specs are here.

## Protection against unresolved items

- `PAYMENT_MODE=disabled` by default, can change to `test` for authorized QA; `live` value is rejected.
- No refund to a real bank/card unless explicit later production deployment; test cancellation only.
- Feature flags control visibility, but permission checks are always enforced by server.
- Don't gate free public discovery behind sign-in or payment.

