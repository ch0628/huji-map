# 09 — Test matrix & acceptance

## Pipeline gates

Every `tasks/NN...` must record: list of files changed, `npm run lint`, `npm run typecheck`, relevant Vitest tests, relevant Playwright smoke if configured, actual pass/fail with summary and `BLOCKED` if credentials missing. Do not claim all tests pass when they could not run. Do not regress earlier phases. No premature 'feature shipped' if only UI mocks.

## Integration acceptance (full test mode only)

| ID | Scenario | Expected |
|---|---|---|
| A01 | guest map public restroom click/directions | no account, no payment, route link; behavioral event logged only if `NEXT_PUBLIC_ANALYTICS_ENABLED=true` and guest accepted consent |
| A02 | guest approved partner detail & directions | view policy/deposit, route link; behavioral event logged only with consent, PIN always absent |
| A03 | unapproved merchant tries publish | forbidden; admin required |
| A04 | partner merchant sees other's business | forbidden |
| A05 | admin approval | draft -> pending -> approved; public visible only when approved |
| A06 | Toss successful TEST payment | server confirms amount/order/owner, one approved order, authorized access |
| A07 | client forges payment success | server refuses PIN and access |
| A08 | wrong amount, wrong customer, replayed confirm | fail safely; no duplicate charge or access |
| A09 | valid paid PIN customer | time-restricted PIN reveal, no-store, audit, own restroom only |
| A10 | anonymous/no payment/wrong restroom PIN request | 401/403/422, PIN absent from response/logs |
| A11 | upload receipt with wrong owner/type/oversized | rejected and inaccessible |
| A12 | customer tries receipt approval | 403, no state change |
| A13 | admin manual receipt approval | review reason/audit, refund eligible but not yet completed |
| A14 | admin TEST full cancellation success | provider confirmed, refund succeeded; duplicate request reuses result |
| A15 | Toss cancel API error/time out | status recoverable/uncertain; don't claim success |
| A16 | no store purchase/valid receipt | test payment stays; no additional charge |
| A17 | repeated click/event UUID | event dedup, distinct browser counts, tri-state consent (`undecided`/`accepted`/`declined`), guest vs authenticated session isolation (no pre-login stitching), admin `전체`/`비로그인`/`로그인` filter, withdrawal enforcement |
| A18 | H5 partner A exposure + B directions | no H5 conversion; sequence & same-restroom guard |
| A19 | (Retired) A19 TravelSurveyBanner | **Intentionally retired**: A19 survey / `landing_view` removed and not restored; replaced by 6 opt-in events with tri-state default-`undecided` full-screen first-visit consent UI on `/` & public routes (`휴지맵 시작하기` + 4 plain-Korean accordions & expandable privacy details), user-menu `이용 통계 설정` modal, and `/privacy` (`/map?analyticsDetails=1`) & `/settings/privacy` (`/map?analyticsSettings=1`) redirects (standalone privacy pages retired) |
| A20 | no secrets check | keys/PIN absent from client build, logs, version control |
| A21 | mobile 360px, geolocation denied | restrooms can still be searched, buttons accessible |
| A22 | no integration credentials | safe setup required UI; no invented successful payment/map |

## Core UI journeys

- Public map -> detail -> directions (no auth).
- Partner map -> detail -> directions -> login -> test checkout -> server confirm -> PIN -> receipt upload -> admin manual approval -> cancellation -> receipt status.
- Merchant signup -> business draft -> owner verification -> admin approve -> partner restroom draft -> publish -> safe PIN change.
- Admin lead entry -> contact log -> business validation -> H1/H2/H5 report.

## PMF certification caveat

19 detailed prior rules source not attached; initial analytics runs are provisional. Show raw counts, source/clock interval, dedup method and `rulesComplete:false` until original rules inserted and checked. Do not present results as actual collected until campaign runs.

