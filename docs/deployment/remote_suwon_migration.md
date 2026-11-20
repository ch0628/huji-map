# 원격 Supabase 수원시 공공화장실 이전 절차서 (STEP 3)

> **주의**: 이 문서의 원격 적용 명령(`--remote`, `--live --confirm`)은 **사용자 승인 후**에만 실행합니다.

## 1. 이전 범위 및 제외 원칙

- **이전 대상**: 경기도 공중화장실 현황(`15011425` / `Publtolt`)과 이름·도로명/지번주소가 **1:1 정확히 일치**하고 유효한 WGS84 좌표를 보유한 수원시 공공화장실만 이전 (`type = 'public' AND publication_status = 'published' AND coordinate_source = 'gg_publtolt_15011425'`).
- **절대 제외**:
  - 로컬 QA 계정 (`auth.users`, `profiles`, `user_roles`)
  - 테스트 제휴 가게 및 제휴 화장실 (`type = 'partner'`, `DEMO/TEST`)
  - 좌표 미확보 초안 (`publication_status = 'draft'`)
  - 매칭 실패/모호 보류 건 및 카카오 API 유래 좌표 (`coordinate_source = 'kakao_geocode'`)
  - 수원시 외 타 지자체 화장실

## 2. 사전 백업 절차 (원격 DB 변경 전 필수)

```powershell
# 1) 현재 원격 스키마 및 데이터 백업 (로컬 local-data/ 저장, Git 제외)
npx supabase db dump --remote --schema public -f local-data/remote_pre_step3_schema.sql
npx supabase db dump --remote --data-only --schema public -f local-data/remote_pre_step3_data.sql
```

## 3. 원격 스키마 마이그레이션 순서 (승인 후)

현재 원격(`wddnbycimcixskemssct`)에는 `20261106000000`~`20261119020000` (17건)이 적용되어 있으며 아래 3건이 대기 중입니다.

1. `20261120000000_restroom_nearby_search_rpc.sql` — 주변 400m 거리순 검색 RPC
2. `20261121000000_restroom_photos_storage_and_review.sql` — 비공개 사진 버킷/검수
3. `20261122000000_restroom_coordinate_provenance.sql` — 좌표 출처/원천 식별자 컬럼·보호 트리거

```powershell
# 1) 드라이런 확인
npx supabase db push --dry-run --remote

# 2) 승인 후 실제 스키마 반영
npx supabase db push --remote
npx supabase migration list --remote
```

## 4. 선별 데이터 적재 절차 (승인 후)

```powershell
# 1) 패키지 무결성 사전 검증 (DRY-RUN, 원격 변경 없음)
npx tsx scripts/prepare-remote-suwon-migration.ts --dry-run

# 2) 원격 시크릿 환경변수(현재 쉘 세션 전용, 파일 저장 금지) 설정 후 소량 시험 적재 (50건)
# $env:REMOTE_SUPABASE_URL = "https://wddnbycimcixskemssct.supabase.co"
# $env:REMOTE_SUPABASE_SECRET_KEY = "<Supabase Dashboard Secret Key>"
npx tsx scripts/prepare-remote-suwon-migration.ts --sample 50 --live --confirm

# 3) 시험 적재 50건 및 list_nearby_public_restrooms RPC 정상 동작 확인 후 전체(502건) 적재
npx tsx scripts/prepare-remote-suwon-migration.ts --batch-size 250 --live --confirm
```

## 5. 적재 후 원격 검증 체크리스트

1. `SELECT type, publication_status, coordinate_source, count(*) FROM public.restrooms GROUP BY 1, 2, 3;` → `public / published / gg_publtolt_15011425`만 존재하고 `kakao_geocode` / `partner` / `draft` 0건 확인.
2. `SELECT count(*) FROM public.restroom_access_policies WHERE access_mode = 'free' AND is_active = true;` → 적재된 화장실 건수와 1:1 일치 확인.
3. `SELECT count(*) FROM public.list_nearby_public_restrooms(37.2636, 127.0286, 400, 'public', 100, 0);` → 수원시청 반경 400m 거리순 조회 정상 확인.
4. `ANALYZE public.restrooms; ANALYZE public.restroom_access_policies;` 실행 후 쉘 환경변수(`REMOTE_SUPABASE_SECRET_KEY`) 즉시 제거.
