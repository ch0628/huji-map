# 02 — Architecture & module boundaries

## 스택

- Next.js 안정 버전(App Router), TypeScript strict, Tailwind CSS, Node.js LTS.
- `@supabase/ssr` 기반 Supabase Auth cookie SSR, Supabase Postgres, Supabase Storage(영수증 private).
- `zod` for request validation; `vitest` unit/integration tests, `playwright` e2e if available.
- Kakao Maps JS SDK behind typed `MapProvider` interface. Korean first.
- Toss Payments SDK **v2 test keys only**, server approval/cancellation with Test Secret. No actual billing.
- Vercel-ready; no paid infrastructure creation without authorization.

## Client/Server boundary

Browser: UI, map SDK (public JS key only), location *with permission*, click UX, signed-in session cookies. Browser calls own `/api/*` endpoints.

Next.js server: authorizes user via trusted Supabase Auth, validates input, fetches public DB response, performs PG APIs, verifies business ownership, signs short-lived access to receipt media, decrypts PIN only upon permission.

DB: all app tables RLS enabled, deny-by-default for direct anon/authenticated access. Service-role client exclusively server-side for app API DB reads/writes. Server routes must check access per operation. Auth signup profile trigger is SECURITY DEFINER, strict search_path.

Data ingestion: scheduled/manual import from licensed public sources to DB with source ID, record ID, imported/verified timestamps; don't query external data on each map view.

## Directory architecture

```
src/app/(public)/map, /restrooms/[id]
src/app/(auth)/login, /signup
src/app/(customer)/my/access, /my/receipts
src/app/merchant/businesses, /merchant/restrooms
src/app/admin/businesses, /admin/receipts, /admin/analytics
src/app/payment/success, /payment/fail
src/app/api/v1/{restrooms,businesses,merchant,admin,events,payments,access,receipts}
src/components/{map,restroom,business,payment,layout,ui}
src/lib/{supabase,auth,db,maps,events,payments,access,receipts,validation}
supabase/migrations/
tests/{unit,integration,e2e}
```

## Design decisions

- `role` is membership-based; users may be both customer and merchant. Cannot self-assign admin.
- Geographic data WGS84 float lat/lng; map adapter converts if needed. Server map queries bbox+limit, bounds validated to avoid full table scans.
- Public REST response uses explicit field allowlist. Never serialize DB row containing PIN, emails, internal contact notes or payment provider keys to public response.
- Payment/access/receipt/refund use separate state machines. Money-related statuses change server-side only.
- No real merchant subscription tables/actions now; add later after actual paid subscription design.
- Missing integration keys: no real map/payment preview; clear configure-needed UI and docs, not fake success.

## Dependency order

base infra -> auth and permissions -> business -> restroom catalogue/import -> map -> event instrumentation -> payment test order/approval -> secure PIN -> receipt upload -> admin review -> test refund -> full integration/deploy.

