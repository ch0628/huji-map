# 06 — Event tracking & PMF analytics

## Recording strategy

- `visitor_sessions` stores session + UTM and random browser ID. `event_logs` stores atomic actions. `audit_logs` stores sensitive operator changes. `payment_orders` / refunds / access / receipts are authoritative state.
- Event fields: client_event_id(UUID dedup), event_name(version), browser_id, session_id, user_id (if any), business_id, restroom_id, access_session_id, experiment_key, page_path, component_id, properties(minimal whitelisted), source(client/server), is_test, occurred_at, received_at.
- `browser_id` identifies **a browser, not a human**; allow opt-out/policy requirements, store consent version. Do not collect continuous GPS trails or raw full IP in event payload.
- Server sets `received_at`, protects trusted events from spoofing, rejects unknown event names and properties, rate limits; client events do not prove purchase/access.

## Required client event names

`landing_view`, `travel_answer_submitted`, `map_loaded`, `restroom_marker_clicked`, `restroom_card_viewed`, `restroom_detail_opened`, `directions_clicked`, `payment_button_clicked`, `payment_unavailable_shown`, `checkout_opened`, `receipt_upload_clicked`, `business_registration_submitted`.

## Required server event names

`business_registration_approved`, `payment_order_created`, `payment_confirmed`, `payment_failed`, `access_authorized`, `pin_reveal_requested`, `pin_reveal_succeeded`, `pin_reveal_denied`, `receipt_submitted`, `receipt_review_approved`, `receipt_review_rejected`, `receipt_resubmission_requested`, `refund_requested`, `refund_succeeded`, `refund_failed`, `visit_confirmation_recorded`.

## H1/H2/H5 (2026-11-04 agreed metrics)

H1: 50 **distinct contacted businesses** out of supplied lead target list, ≥ 5 valid approved registrations satisfying agreed conditions. A contact_attempt record exists for counted denominator. Store registration validity/admin decision separately. Note early interviews 5 with 0 confirmations not H1 result.

H2: Ad landing browser marked `travelingNow=true` in same testing window; among **first/eligible 50 distinct browser IDs** (according to canonical detailed rules), ≥ 5 distinct browsers performed `directions_clicked`. Do not call this a visit/payment success.

H5: Among 50 distinct browser IDs actually **exposed to an approved partner restroom card**, ≥5 clicked directions for that **same partner restroom**. Separate numerator and denominator, do not mistake all map visitors or public restroom directions for H5.

1차 window: 2026-11-05 09:00 KST through 2026-11-18 23:59 KST, verdict 2026-11-19 morning. If operational start delayed record real observed window and avoid retroactive filling. Test traffic is excluded using `is_test`/QA session markers. Baseline thresholds not automatically revised for payment addition.

IMPORTANT: Exact 19 sub-rules as confirmed in prior team work have not been supplied to this workspace. Don't fabricate edge rules; metrics report MUST say `rulesComplete:false` until the canonical list is imported and tested. Add import/verification later if source provided.

## Exposure semantics / analytics caveat

`restroom_card_viewed` = UI exposure event, not marker click. Use an explicit reliable visibility trigger and dedup key client_event_id; set `properties.cardType=partner|public` and `properties.visibilityRuleVersion=...`. If full canonical rule missing, display raw eligible counts separately and do not label official success.

## Analytics queries/presentations

Admin dashboard: raw contacts, approved registered, ad browser qualifiers, card exposure unique browsers, directions unique browsers (for H5 join by same restroom ID), funnel conversion rates, unknown rule warning. Show underlying event count and deduplicated browsers distinctly. No email/PIN/receipt data in exports.

## Tests

- double-click duplicate event -> one client_event_id in DB;
- repeat anonymous session -> same browser ID and new session ID;
- public restroom direction does not count H5;
- unrelated partner A card + partner B direction does not count H5;
- organic non-ad visitor does not count H2;
- demo/QA traffic excluded;
- client-sent `payment_confirmed` rejected, server source only.

