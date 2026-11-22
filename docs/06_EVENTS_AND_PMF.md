# 06 — Event tracking & PMF analytics

## Recording strategy

- `visitor_sessions` stores session + UTM and random browser ID. `event_logs` stores atomic actions. `audit_logs` stores sensitive operator changes. `payment_orders` / refunds / access / receipts are authoritative state.
- Event fields: client_event_id(UUID dedup), event_name(version), browser_id, session_id, user_id (if any), business_id, restroom_id, access_session_id, experiment_key, page_path, component_id, properties(minimal whitelisted), source(client/server), is_test, occurred_at, received_at.
- `browser_id` identifies **a browser, not a human**; allow opt-out/policy requirements, store consent version. Do not collect continuous GPS trails or raw full IP in event payload.
- Server sets `received_at`, protects trusted events from spoofing, rejects unknown event names and properties, rate limits; client events do not prove purchase/access.

## Active optional behavioral events (opt-in only, 6 events)

When `NEXT_PUBLIC_ANALYTICS_ENABLED === "true"` **and** the user has explicitly opted in via the tri-state consent flow (`hm_consent_v1.analyticsStatus === "accepted"`, default `"undecided"` matching `PRIVACY_POLICY_VERSION`), both unauthenticated visitors and authenticated users emit strictly these 6 behavioral events:

1. `map_loaded` — map canvas initialization succeeded (scale of map usage; also emits once immediately if consent is granted while `/map` is already open)
2. `restroom_marker_clicked` — user clicked a restroom marker on the map
3. `restroom_card_viewed` — a restroom card is actually displayed (selected marker/list drawer; source-tagged)
4. `restroom_detail_opened` — `/restrooms/[id]` detail page viewed (StrictMode/mount deduplicated; emits once on late consent while on the page)
5. `directions_clicked` — user clicked external navigation (`kakao` / `naver` / `google`) with `restroom_id` & `restroom_type`
6. `payment_button_clicked` — user clicked deposit payment button on an eligible partner restroom detail

Consent UX:
- First visit on `/` or public discovery routes (`/map`, `/restrooms/*`) when status is `undecided` (regardless of login state or `NEXT_PUBLIC_ANALYTICS_ENABLED`): renders the full-screen first-visit consent UI (`휴지맵 시작하기`, `더 편리한 화장실 지도를 만들 수 있도록 서비스 이용 통계 수집에 참여해 주세요.`) directly from SSR via functional cookie `hm_consent_pref` check (eliminating map/home flash before consent) with 4 collapsed-by-default plain-Korean accordions (`어떤 정보를 수집하나요?`, `어디에 활용하나요?`, `동의하지 않아도 이용할 수 있나요?`, `개인정보 처리 안내` + expandable detailed privacy notice without internal DB/API/event identifiers) and bottom buttons (`동의하고 시작하기`, `동의 없이 시작하기`); ESC dismissal leaves status `undecided` without collecting events or minting `hm_browser_id`.
- Standalone `/privacy` and `/settings/privacy` pages are retired and redirect to `/map?analyticsDetails=1` (opens `개인정보 처리 안내` + detailed disclosure) and `/map?analyticsSettings=1` respectively.
- Changes/withdrawal: user menu `이용 통계 설정` opens the compact `PrivacySettingsClient` modal with ON/OFF toggle and collapsible detail items directly without navigating to a separate privacy page.

## Unauthenticated vs authenticated group separation

- Server derives `is_authenticated = Boolean(user_id)` on `visitor_sessions` and `event_logs` exclusively from `getServerAuthSession()` (`supabase.auth.getUser()`), without trusting client flags or adding new SQL migrations (`user_id` column already exists).
- Pre-login anonymous sessions are never auto-stitched into post-login accounts: `syncAnalyticsAuthBoundary` rotates `hm_session_id`/`hm_session_token` across login/logout without mutating consent, and the server rejects authenticated requests targeting an anonymous `visitor_sessions` row (`403 SESSION_OWNERSHIP_MISMATCH`).

Excluded / retired client items (do NOT re-enable):
- A19 `TravelSurveyBanner` (`travel_answer_submitted`), `landing_view`, `payment_unavailable_shown`, `checkout_opened`, generic auto-click tracking, GPS trails, plaintext PINs, receipt images, secrets, or individual login success events.

## Required server event names / authoritative server tables

- Authoritative payment & usage completion MUST come from server DB tables (`payment_orders`, `access_sessions`, `receipt_submissions`, `payment_refunds`) — never from client click events.
- Test-mode payments (`payment_mode = 'test'`) are always distinguished from real money willingness-to-pay.
- Existing server event names remain restricted (`source = 'server'`): `business_registration_approved`, `payment_order_created`, `payment_confirmed`, `payment_failed`, `access_authorized`, `pin_reveal_requested`, `pin_reveal_succeeded`, `pin_reveal_denied`, `receipt_submitted`, `receipt_review_approved`, `receipt_review_rejected`, `receipt_resubmission_requested`, `refund_requested`, `refund_succeeded`, `refund_failed`, `visit_confirmation_recorded`.

## H1/H2/H5 (2026-11-04 agreed metrics)

H1: 50 **distinct contacted businesses** out of supplied lead target list, ≥ 5 valid approved registrations satisfying agreed conditions. A contact_attempt record exists for counted denominator. Store registration validity/admin decision separately. Note early interviews 5 with 0 confirmations not H1 result.

H2: Ad landing browser marked `travelingNow=true` in same testing window; among **first/eligible 50 distinct browser IDs** (according to canonical detailed rules), ≥ 5 distinct browsers performed `directions_clicked`. Do not call this a visit/payment success.

H5: Among 50 distinct browser IDs actually **exposed to an approved partner restroom card**, ≥5 clicked directions for that **same partner restroom**. Separate numerator and denominator, do not mistake all map visitors or public restroom directions for H5.

1차 window: 2026-11-05 09:00 KST through 2026-11-18 23:59 KST, verdict 2026-11-19 morning. If operational start delayed record real observed window and avoid retroactive filling. Test traffic is excluded using `is_test`/QA session markers. Baseline thresholds not automatically revised for payment addition.

IMPORTANT: Exact 19 sub-rules as confirmed in prior team work have not been supplied to this workspace. Don't fabricate edge rules; metrics report MUST say `rulesComplete:false` until the canonical list is imported and tested. Add import/verification later if source provided.

## Exposure semantics / analytics caveat

`restroom_card_viewed` = UI exposure event, not marker click. Use an explicit reliable visibility trigger and dedup key client_event_id; set `properties.cardType=partner|public` and `properties.visibilityRuleVersion=...`. If full canonical rule missing, display raw eligible counts separately and do not label official success.

## Analytics queries/presentations

Admin dashboard (`/admin/analytics/pmf`, menu label `서비스 이용 분석`):
- Sections: A) 서비스 이용 규모 (`mapBrowsers`, `map_loaded`, consent scope notice, authenticated/guest split summary), B) 화장실 관심도 (`restroom_marker_clicked`, `restroom_card_viewed`, `restroom_detail_opened`, public vs partner, per-restroom interest ranking), C) 이용 의사 (`directions_clicked`, per-restroom directions ranking, sequence-aware `restroom_card_viewed -> directions_clicked` same `(browser_id, restroom_id)`, partner `restroom_detail_opened -> payment_button_clicked` rate), D) 기존 서버 거래·이용권 기록 (test-mode payments & issued `access_sessions`).
- Segment filter (`authFilter`: `전체` / `비로그인` / `로그인`): applies consistently to Sections A–C, event breakdown, conversion rates, rankings, and KST daily behavioral trends based strictly on server-verified `user_id` presence (`user_id IS NULL` vs `user_id IS NOT NULL`), while keeping Section D server transaction records unfiltered with an explicit UI notice.
- Show event counts and distinct `browser_id` counts separately (never describe unique browsers as unique humans).
- KST daily trend buckets, `is_test` include/exclude toggle (excluded by default), and `데이터 부족` when denominator is 0 / empty.
- Legacy H1/H2/H5 hypotheses (`rulesComplete: false`) stay isolated and clearly marked provisional. No email/PIN/receipt data in analytics responses or exports.

## Tests

- double-click duplicate event -> one client_event_id in DB;
- repeat anonymous session -> same browser ID and new session ID;
- public restroom direction does not count H5;
- unrelated partner A card + partner B direction does not count H5;
- organic non-ad visitor does not count H2;
- demo/QA traffic excluded;
- client-sent `payment_confirmed` rejected, server source only.

