-- Migration: 20261126000000_nationwide_official_sources_and_candidates.sql
-- Purpose:
--   TASK 2: Allow newly verified municipal/public-portal official coordinate sources
--           (strictly requiring coordinate_type = 'facility_official' and
--            coordinate_verification_status = 'VERIFIED').
--   TASK 3: Create public.public_restroom_candidates table for nationwide unlocated
--           standard records with administrative region codes, normalized name/address,
--           non-unique facility_hash for duplicate-candidate inspection, and partial
--           composite indexes. Strictly stores NO coordinates and NO geohash.

-- ============================================================================
-- 1. EXPAND OFFICIAL COORDINATE SOURCE ALLOWLIST (TASK 2)
-- ============================================================================

alter table public.restrooms
  drop constraint if exists chk_restrooms_coordinate_source_values;

alter table public.restrooms
  add constraint chk_restrooms_coordinate_source_values
  check (
    coordinate_source is null
    or coordinate_source in (
      'gg_publtolt_15011425',
      'mois_address_nav_db',
      'mois_address_summary_db',
      'seoul_public_toilet_info',
      'seoul_metro_2026',
      'incheon_district_public_toilet',
      'gyeonggi_city_public_toilet',
      'jeonbuk_public_toilet',
      'gwangju_public_toilet',
      'busan_district_public_toilet',
      'kakao_geocode',
      'partner_kakao_js',
      'admin_manual',
      'public_csv_original',
      'other'
    )
  );

create or replace function public.is_restroom_coordinate_publicly_allowed(
  p_type text,
  p_coordinate_source text,
  p_coordinate_type text,
  p_coordinate_verification_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public, pg_temp
as $$
  select case
    when p_type = 'partner' then
      coalesce(p_coordinate_source, '') not in (
        'kakao_geocode',
        'mois_address_nav_db',
        'mois_address_summary_db'
      )
      and coalesce(p_coordinate_type, '') not in (
        'building_centroid',
        'main_entrance',
        'complex_centroid_mean',
        'geocoded'
      )
    when p_type = 'public' then
      coalesce(
        (
          -- Legacy protected Suwon 502 baseline (coordinate_type / status may be NULL)
          p_coordinate_source = 'gg_publtolt_15011425'
          and (p_coordinate_type is null or p_coordinate_type = 'facility_official')
          and (p_coordinate_verification_status is null or p_coordinate_verification_status = 'VERIFIED')
        )
        or (
          -- Approved official municipal/transit datasets require facility_official + VERIFIED
          p_coordinate_source in (
            'seoul_public_toilet_info',
            'seoul_metro_2026',
            'incheon_district_public_toilet',
            'gyeonggi_city_public_toilet',
            'jeonbuk_public_toilet',
            'gwangju_public_toilet',
            'busan_district_public_toilet',
            'admin_manual'
          )
          and p_coordinate_type = 'facility_official'
          and p_coordinate_verification_status = 'VERIFIED'
        ),
        false
      )
    else false
  end;
$$;

revoke all on function public.is_restroom_coordinate_publicly_allowed(text, text, text, text) from public;
grant execute on function public.is_restroom_coordinate_publicly_allowed(text, text, text, text)
  to anon, authenticated, service_role;

-- ============================================================================
-- 2. NATIONWIDE UNLOCATED CANDIDATE INDEX TABLE (TASK 3)
-- ============================================================================
-- Note: Deliberately stores NO latitude, NO longitude, and NO geohash.
--       Counts in this table are managed completely separately from public.restrooms.

create table if not exists public.public_restroom_candidates (
  id uuid primary key default gen_random_uuid(),
  source_provider text not null check (char_length(trim(source_provider)) > 0 and char_length(source_provider) <= 150),
  source_dataset_id text not null check (char_length(trim(source_dataset_id)) > 0 and char_length(source_dataset_id) <= 100),
  source_record_id text not null check (char_length(trim(source_record_id)) > 0 and char_length(source_record_id) <= 150),
  name text not null check (char_length(trim(name)) > 0 and char_length(name) <= 200),
  normalized_name text not null check (char_length(trim(normalized_name)) > 0 and char_length(normalized_name) <= 200),
  road_address text null check (road_address is null or char_length(road_address) <= 300),
  jibun_address text null check (jibun_address is null or char_length(jibun_address) <= 300),
  normalized_address text not null check (char_length(trim(normalized_address)) > 0 and char_length(normalized_address) <= 300),
  sido_code text not null check (char_length(trim(sido_code)) between 2 and 10),
  sigungu_code text not null check (char_length(trim(sigungu_code)) between 4 and 12),
  eupmyeondong_code text null check (eupmyeondong_code is null or char_length(eupmyeondong_code) <= 12),
  sido_name text not null check (char_length(trim(sido_name)) > 0 and char_length(sido_name) <= 60),
  sigungu_name text not null check (char_length(trim(sigungu_name)) > 0 and char_length(sigungu_name) <= 60),
  eupmyeondong_name text null check (eupmyeondong_name is null or char_length(eupmyeondong_name) <= 60),
  admin_org_code text null check (admin_org_code is null or char_length(admin_org_code) <= 20),
  facility_type text null check (facility_type is null or char_length(facility_type) <= 60),
  open_hours text null check (open_hours is null or char_length(open_hours) <= 500),
  closed_days text null check (closed_days is null or char_length(closed_days) <= 200),
  gender_type text not null default 'unknown' check (
    gender_type in ('male', 'female', 'separate', 'unisex', 'unknown')
  ),
  wheelchair_accessible boolean null,
  baby_changing_available boolean null,
  managing_agency text null check (managing_agency is null or char_length(managing_agency) <= 150),
  phone text null check (phone is null or char_length(phone) <= 60),
  public_metadata jsonb not null default '{}'::jsonb,
  coordinate_status text not null default 'unlocated' check (
    coordinate_status in (
      'unlocated',
      'official_matched',
      'held_ambiguous',
      'held_license',
      'duplicate_official',
      'excluded'
    )
  ),
  matched_restroom_id uuid null references public.restrooms(id) on delete set null,
  facility_hash text not null check (char_length(facility_hash) between 16 and 128),
  source_base_date date null,
  license_name text null check (license_name is null or char_length(license_name) <= 200),
  license_url text null check (license_url is null or char_length(license_url) <= 500),
  attribution_text text null check (attribution_text is null or char_length(attribution_text) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint uq_prc_source_record unique (source_dataset_id, source_record_id),
  constraint chk_prc_has_address check (
    (road_address is not null and char_length(trim(road_address)) > 0)
    or (jibun_address is not null and char_length(trim(jibun_address)) > 0)
  )
);

-- Non-unique facility_hash index (duplicate candidate discovery only, never auto-merge)
create index if not exists idx_prc_facility_hash
  on public.public_restroom_candidates(facility_hash);

-- Partial & composite indexes for viewport region queries on unlocated candidates
create index if not exists idx_prc_region_codes_unlocated
  on public.public_restroom_candidates(sido_code, sigungu_code, eupmyeondong_code)
  where coordinate_status = 'unlocated';

create index if not exists idx_prc_sigungu_unlocated
  on public.public_restroom_candidates(sigungu_code, id)
  where coordinate_status = 'unlocated';

create index if not exists idx_prc_region_names_unlocated
  on public.public_restroom_candidates(sido_name, sigungu_name)
  where coordinate_status = 'unlocated';

create index if not exists idx_prc_status
  on public.public_restroom_candidates(coordinate_status);

create index if not exists idx_prc_matched_restroom
  on public.public_restroom_candidates(matched_restroom_id)
  where matched_restroom_id is not null;

-- Normalized address & facility name prefix/search indexes for unlocated candidates
create index if not exists idx_prc_norm_addr_unlocated
  on public.public_restroom_candidates(normalized_address text_pattern_ops)
  where coordinate_status = 'unlocated';

create index if not exists idx_prc_norm_name_unlocated
  on public.public_restroom_candidates(normalized_name text_pattern_ops)
  where coordinate_status = 'unlocated';

drop trigger if exists trg_public_restroom_candidates_updated_at on public.public_restroom_candidates;
create trigger trg_public_restroom_candidates_updated_at
  before update on public.public_restroom_candidates
  for each row
  execute function public.handle_updated_at();

-- RLS: Default deny writes; anon/authenticated can only read unlocated candidate metadata
alter table public.public_restroom_candidates enable row level security;

revoke all on table public.public_restroom_candidates from public, anon, authenticated;
grant select on table public.public_restroom_candidates to anon, authenticated;
grant all on table public.public_restroom_candidates to service_role;

drop policy if exists "prc_select_anon" on public.public_restroom_candidates;
create policy "prc_select_anon"
  on public.public_restroom_candidates
  for select
  to anon
  using (coordinate_status = 'unlocated');

drop policy if exists "prc_select_authenticated" on public.public_restroom_candidates;
create policy "prc_select_authenticated"
  on public.public_restroom_candidates
  for select
  to authenticated
  using (
    coordinate_status = 'unlocated'
    or public.is_admin(auth.uid())
  );

drop policy if exists "prc_admin_write" on public.public_restroom_candidates;
create policy "prc_admin_write"
  on public.public_restroom_candidates
  for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));
