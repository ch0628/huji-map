# 05 — Screen and UI interactions

## Design principles

Mobile-first, target 360px min, Korean labels, readable contrast, interactive targets >= 44px, loading/empty/error states, keyboard accessible, safe-area aware bottom sheet, fast map load. Avoid decorative marketing page crowding emergency use. No login gate before map.

| Screen (suggested path) | Required elements | Actions and result |
|---|---|---|
| `/` redirect `/map` | route shell | initial session+UTM preserved |
| `/map` | Kakao map, my-location optional, public/partner filter, search, card bottom sheet | marker click -> card view event; selecting restroom opens detail; deny geolocation -> search still works |
| `/restrooms/[id]` | name, actual verified status/time, accessibility unknown marker, entry instructions, business info, deposit and terms, photos | `길찾기` always; for public no payment; for partner `보증금 결제` next |
| `/login` `/signup` | minimum fields and validation | password handled via Supabase Auth, returns to intended action |
| `/payment/start?restroomId=` | real policy/deposit (TEST watermark), agreed terms | request server order; Toss widget; only test customers |
| `/payment/success` `/payment/fail` | server-confirmed status vs pending/error | show access link only after server confirm |
| `/my/access` | access status/expiry, partner name | PIN reveal button only eligible, visible code deliberately on demand |
| `/my/access/[id]/receipt` | photo upload, allowed types/size, status | submission, re-submit when allowed, no OCR |
| `/my/receipts` | submitted/under review/approved/refund requested/complete | show accurate status, no promises of instant refund |
| `/merchant/businesses` | owned businesses and approval statuses | create/edit/submit |
| `/merchant/restrooms` | owned restrooms, access times, photo, policy, lock state | save draft, request publish, rotate PIN only verified owner |
| `/admin/businesses` | list pending registrations and verification details | approve/reject reason, log |
| `/admin/restrooms` | submissions, suspend/restore and verification date | approve/disable |
| `/admin/receipts` | manual image viewer, comparison with business registration/order time, duplicate warning | approve/reject/reupload; separate refund request |
| `/admin/analytics` | denominator/numerator for H1/H2/H5, source windows and test exclusions | download aggregate data if needed, no user PII in report |

## UI state contract

- No Kakao key: `지도 설정이 필요합니다` and safe configuration hint (not fake map). Generic informational landing might show only non-map UI; cannot claim working map.
- Unverified partner: never visible to public.
- Pin without eligible access: never included in page props or server-rendered HTML. UI shows `결제 승인 후 확인 가능`.
- PG test mode: prominent `테스트 결제 · 실제 돈은 청구되지 않음` everywhere on payment/access/receipt.
- PG disabled: `현재 결제 기능 준비 중` (button tracking should remain) and no PIN reveal.
- Receipt pending: `관리자 검토 중`. Approved: `환급 승인` until provider cancel succeeded, then `테스트 환급 완료`.
- For public restrooms: map navigation works without account, deposit, receipt.
- For partner: navigation is **not blocked** by checkout; access/use requires validated purchase.

## Event interactions

Use `docs/06_EVENTS_AND_PMF.md` event names. `directions_clicked` triggered before opening external Kakao navigation; do not count opening the map as visit or actual usage.

