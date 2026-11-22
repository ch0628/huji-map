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
- Optional behavioral analytics is strictly limited to 6 events (`map_loaded`, `restroom_marker_clicked`, `restroom_card_viewed`, `restroom_detail_opened`, `directions_clicked`, `payment_button_clicked`), requires explicit user opt-in (tri-state default `undecided` via full-screen first-visit consent UI `휴지맵 시작하기` shown first on `/` and public routes regardless of auth or env flag, with 4 plain-Korean accordions + expandable privacy details, SSR `hm_consent_pref` flash prevention, and user-menu `이용 통계 설정` modal; standalone `/privacy` & `/settings/privacy` pages retired and redirected to `/map?analyticsDetails=1` & `/map?analyticsSettings=1`), separates unauthenticated vs authenticated analytics via server-verified `user_id` without pre-login account stitching, and never alters core auth/payment/refund flows. A19 `TravelSurveyBanner` is permanently removed.
- Receipt resubmission is permitted only when `submission_status === 'resubmission_requested'`; `rejected` stays blocked (`20261123000000`).
- Identical restroom access policy updates are rejected (`409 POLICY_UNCHANGED` / `HM002`) without incrementing policy version (`20261123010000`).
- Exact retention period and formal statutory disclosures require external legal review before public live launch.

