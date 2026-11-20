-- Migration: 20261122000000_restroom_coordinate_provenance.sql
-- Purpose: STEP 3 Coordinate provenance tracking to strictly distinguish
--          Gyeonggi public data (15011425 / Publtolt) coordinates from
--          legacy Kakao geocoded coordinates and partner coordinates.

-- ============================================================================
-- 1. ADD COORDINATE PROVENANCE COLUMNS TO public.restrooms
-- ============================================================================

alter table public.restrooms
  add column if not exists coordinate_source text null;

alter table public.restrooms
  add column if not exists coordinate_source_id uuid null references public.public_data_sources(id) on delete set null;

alter table public.restrooms
  add column if not exists coordinate_source_record_id text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_restrooms_coordinate_source_values'
      and conrelid = 'public.restrooms'::regclass
  ) then
    alter table public.restrooms
      add constraint chk_restrooms_coordinate_source_values
      check (
        coordinate_source is null
        or coordinate_source in (
          'gg_publtolt_15011425',
          'kakao_geocode',
          'partner_kakao_js',
          'admin_manual',
          'public_csv_original',
          'other'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_restrooms_coordinate_source_record_len'
      and conrelid = 'public.restrooms'::regclass
  ) then
    alter table public.restrooms
      add constraint chk_restrooms_coordinate_source_record_len
      check (
        coordinate_source_record_id is null
        or char_length(coordinate_source_record_id) <= 200
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_restrooms_coordinate_source_consistency'
      and conrelid = 'public.restrooms'::regclass
  ) then
    alter table public.restrooms
      add constraint chk_restrooms_coordinate_source_consistency
      check (
        (coordinate_source_id is null and coordinate_source_record_id is null)
        or coordinate_source is not null
      );
  end if;
end $$;

create index if not exists idx_restrooms_coordinate_source
  on public.restrooms(coordinate_source)
  where coordinate_source is not null;

create index if not exists idx_restrooms_coordinate_source_id
  on public.restrooms(coordinate_source_id)
  where coordinate_source_id is not null;

-- ============================================================================
-- 2. PROTECT COORDINATE PROVENANCE FROM NON-ADMIN MUTATIONS
-- ============================================================================

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
         or NEW.coordinate_source_record_id is not null then
        if NEW.type = 'public' then
          raise exception 'Forbidden: coordinate provenance can only be assigned by administrators'
            using errcode = '42501';
        end if;
      end if;
    elsif TG_OP = 'UPDATE' then
      if NEW.coordinate_source is distinct from OLD.coordinate_source
         or NEW.coordinate_source_id is distinct from OLD.coordinate_source_id
         or NEW.coordinate_source_record_id is distinct from OLD.coordinate_source_record_id then
        raise exception 'Forbidden: coordinate provenance columns cannot be altered directly'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_protect_restroom_coordinate_provenance on public.restrooms;
create trigger trg_protect_restroom_coordinate_provenance
  before insert or update on public.restrooms
  for each row
  execute function public.protect_restroom_coordinate_provenance();

-- ============================================================================
-- 3. IDEMPOTENT BACKFILL OF EXISTING LOCAL COORDINATE ORIGINS
-- ============================================================================

update public.restrooms
set coordinate_source = 'kakao_geocode'
where type = 'public'
  and latitude is not null
  and longitude is not null
  and coordinate_source is null;

update public.restrooms
set coordinate_source = 'partner_kakao_js'
where type = 'partner'
  and latitude is not null
  and longitude is not null
  and coordinate_source is null;
