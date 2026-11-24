-- Migration: 20261124000000_restroom_coordinate_verification.sql
-- Purpose: Phase 2 coordinate verification metadata & non-destructive candidate storage.
--          Strictly separates coordinate verification status (VERIFIED / CANDIDATE /
--          REVIEW_REQUIRED / UNMATCHED) from restrooms.publication_status, and protects
--          existing restrooms.latitude/longitude from unverified overwrites.
-- NOTE: Verified locally in PGlite only. Do NOT push to remote without explicit approval.

-- ============================================================================
-- 1. EXPAND coordinate_source ALLOWED VALUES & ADD VERIFICATION METADATA
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
      'kakao_geocode',
      'partner_kakao_js',
      'admin_manual',
      'public_csv_original',
      'other'
    )
  );

alter table public.restrooms
  add column if not exists coordinate_type text null;

alter table public.restrooms
  add column if not exists coordinate_verification_status text null;

alter table public.restrooms
  add column if not exists coordinate_verification_basis text null;

alter table public.restrooms
  add column if not exists coordinate_source_version text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_restrooms_coordinate_type_values'
      and conrelid = 'public.restrooms'::regclass
  ) then
    alter table public.restrooms
      add constraint chk_restrooms_coordinate_type_values
      check (
        coordinate_type is null
        or coordinate_type in (
          'facility_official',
          'building_centroid',
          'main_entrance',
          'complex_centroid_mean',
          'geocoded',
          'manual'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_restrooms_coord_verification_status_values'
      and conrelid = 'public.restrooms'::regclass
  ) then
    alter table public.restrooms
      add constraint chk_restrooms_coord_verification_status_values
      check (
        coordinate_verification_status is null
        or coordinate_verification_status in (
          'VERIFIED',
          'CANDIDATE',
          'REVIEW_REQUIRED',
          'UNMATCHED'
        )
      );
  end if;
end $$;

create index if not exists idx_restrooms_coord_verification_status
  on public.restrooms(coordinate_verification_status)
  where coordinate_verification_status is not null;

-- Protect newly added verification metadata columns from non-admin client edits
create or replace function public.protect_restroom_coordinate_provenance()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') and not public.is_admin(auth.uid()) then
    if TG_OP = 'INSERT' then
      if NEW.coordinate_source is not null
         or NEW.coordinate_source_id is not null
         or NEW.coordinate_source_record_id is not null
         or NEW.coordinate_type is not null
         or NEW.coordinate_verification_status is not null
         or NEW.coordinate_verification_basis is not null
         or NEW.coordinate_source_version is not null then
        if NEW.type = 'public' then
          raise exception 'Forbidden: coordinate provenance can only be assigned by administrators'
            using errcode = '42501';
        end if;
      end if;
    elsif TG_OP = 'UPDATE' then
      if NEW.coordinate_source is distinct from OLD.coordinate_source
         or NEW.coordinate_source_id is distinct from OLD.coordinate_source_id
         or NEW.coordinate_source_record_id is distinct from OLD.coordinate_source_record_id
         or NEW.coordinate_type is distinct from OLD.coordinate_type
         or NEW.coordinate_verification_status is distinct from OLD.coordinate_verification_status
         or NEW.coordinate_verification_basis is distinct from OLD.coordinate_verification_basis
         or NEW.coordinate_source_version is distinct from OLD.coordinate_source_version then
        raise exception 'Forbidden: coordinate provenance columns cannot be altered directly'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

-- ============================================================================
-- 2. NON-DESTRUCTIVE COORDINATE CANDIDATES TABLE (ADMIN / SERVER ONLY)
-- ============================================================================

create table if not exists public.restroom_coordinate_candidates (
  id uuid primary key default gen_random_uuid(),
  restroom_id uuid not null references public.restrooms(id) on delete cascade,
  candidate_source text not null,
  candidate_source_record_id text null,
  candidate_coord_type text not null,
  source_version text not null,
  latitude double precision null,
  longitude double precision null,
  verification_status text not null,
  verification_basis text not null,
  review_reasons text[] not null default '{}',
  distance_to_existing_m double precision null,
  is_selected boolean not null default false,
  reviewed_by uuid null references public.profiles(id) on delete set null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_restroom_coord_candidate_source unique (restroom_id, candidate_source, source_version),
  constraint chk_candidate_coord_type check (
    candidate_coord_type in (
      'facility_official',
      'building_centroid',
      'main_entrance',
      'complex_centroid_mean',
      'geocoded',
      'manual',
      'none'
    )
  ),
  constraint chk_candidate_verification_status check (
    verification_status in ('VERIFIED', 'CANDIDATE', 'REVIEW_REQUIRED', 'UNMATCHED')
  ),
  constraint chk_candidate_coords_pair check (
    (latitude is null and longitude is null)
    or (latitude between -90 and 90 and longitude between -180 and 180)
  )
);

create index if not exists idx_restroom_coord_candidates_status
  on public.restroom_coordinate_candidates(verification_status, candidate_source);

create index if not exists idx_restroom_coord_candidates_restroom
  on public.restroom_coordinate_candidates(restroom_id);

drop trigger if exists trg_restroom_coord_candidates_updated_at on public.restroom_coordinate_candidates;
create trigger trg_restroom_coord_candidates_updated_at
  before update on public.restroom_coordinate_candidates
  for each row
  execute function public.handle_updated_at();

alter table public.restroom_coordinate_candidates enable row level security;

revoke all on table public.restroom_coordinate_candidates from public, anon, authenticated;
grant select, insert, update, delete on table public.restroom_coordinate_candidates to authenticated, service_role;

drop policy if exists "restroom_coord_candidates_admin_all" on public.restroom_coordinate_candidates;
create policy "restroom_coord_candidates_admin_all"
  on public.restroom_coordinate_candidates
  for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));
