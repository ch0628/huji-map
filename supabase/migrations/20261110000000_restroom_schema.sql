-- Migration: 20261110000000_restroom_schema.sql
-- Purpose: TASK 09 Public and Partner Restrooms Schema
--          (public_data_sources, public_import_runs, restrooms, restroom_hours,
--           restroom_hour_exceptions, restroom_access_policies, restroom_photos)
-- Reference: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md,
--            docs/11_DECISIONS.md, tasks/09_restroom_schema.md

-- ============================================================================
-- 1. PUBLIC DATA SOURCES & IMPORT RUNS (docs/03_DATA_MODEL.md lines 151-180)
-- ============================================================================

-- 1.1 public_data_sources — 공공 데이터 출처/라이선스
create table if not exists public.public_data_sources (
  id uuid primary key default gen_random_uuid(),
  provider_name text not null check (char_length(trim(provider_name)) > 0 and char_length(provider_name) <= 100),
  dataset_name text not null check (char_length(trim(dataset_name)) > 0 and char_length(dataset_name) <= 200),
  source_url text not null check (char_length(trim(source_url)) > 0 and char_length(source_url) <= 500),
  api_endpoint text null check (api_endpoint is null or char_length(api_endpoint) <= 500),
  license_name text null check (license_name is null or char_length(license_name) <= 100),
  license_url text null check (license_url is null or char_length(license_url) <= 500),
  attribution_text text null check (attribution_text is null or char_length(attribution_text) <= 500),
  last_synced_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_public_data_sources_provider
  on public.public_data_sources(provider_name);

-- 1.2 public_import_runs — 수집 처리 이력
create table if not exists public.public_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.public_data_sources(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  fetched_count integer not null default 0 check (fetched_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  error_message text null,
  constraint chk_public_import_runs_time check (finished_at is null or finished_at >= started_at)
);

create index if not exists idx_public_import_runs_source_started
  on public.public_import_runs(source_id, started_at desc);

-- ============================================================================
-- 2. RESTROOMS (docs/03_DATA_MODEL.md lines 181-209)
-- ============================================================================

-- 2.1 restrooms — 공공·제휴 화장실 공통 원천
create table if not exists public.restrooms (
  id uuid primary key default gen_random_uuid(),
  business_id uuid null references public.businesses(id) on delete restrict,
  source_id uuid null references public.public_data_sources(id) on delete restrict,
  source_record_id text null check (source_record_id is null or char_length(source_record_id) <= 100),
  type text not null check (type in ('public', 'partner')),
  name text not null check (char_length(trim(name)) > 0 and char_length(name) <= 200),
  description text null check (description is null or char_length(description) <= 2000),
  road_address text not null check (char_length(trim(road_address)) > 0 and char_length(road_address) <= 300),
  address_detail text null check (address_detail is null or char_length(address_detail) <= 200),
  latitude double precision null check (latitude is null or (latitude >= -90.0 and latitude <= 90.0)),
  longitude double precision null check (longitude is null or (longitude >= -180.0 and longitude <= 180.0)),
  floor text null check (floor is null or char_length(floor) <= 50),
  entrance_instructions text null check (entrance_instructions is null or char_length(entrance_instructions) <= 1000),
  gender_type text not null default 'unknown' check (
    gender_type in ('male', 'female', 'separate', 'unisex', 'unknown')
  ),
  wheelchair_accessible boolean null,
  baby_changing_available boolean null,
  sanitary_products_available boolean null,
  access_method text not null default 'open' check (
    access_method in ('open', 'ask_staff', 'pin')
  ),
  publication_status text not null default 'draft' check (
    publication_status in ('draft', 'pending', 'published', 'suspended', 'archived')
  ),
  last_verified_at timestamptz null,
  created_by uuid null references public.profiles(id) on delete set null,
  approved_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Foreign key exclusivity: partner -> business_id, public -> source_id
  constraint chk_restrooms_type_references check (
    (type = 'partner' and business_id is not null and source_id is null) or
    (type = 'public' and business_id is null and source_id is not null)
  ),

  -- Public restrooms never use PIN access
  constraint chk_restrooms_public_no_pin check (
    type <> 'public' or access_method <> 'pin'
  ),

  -- Draft and pending records must not have an approved_by assigned
  constraint chk_restrooms_draft_no_approval check (
    publication_status not in ('draft', 'pending') or approved_by is null
  ),

  -- Coordinates must either both be null (unverified/draft) or both be present
  constraint chk_restrooms_coords_pair check (
    (latitude is null and longitude is null) or
    (latitude is not null and longitude is not null)
  ),

  -- Published restrooms must always have valid coordinates
  constraint chk_restrooms_published_has_coords check (
    publication_status <> 'published' or (latitude is not null and longitude is not null)
  )
);

-- Unique source record identifier per source
create unique index if not exists idx_restrooms_source_unique
  on public.restrooms(source_id, source_record_id)
  where source_id is not null and source_record_id is not null;

create index if not exists idx_restrooms_business_id
  on public.restrooms(business_id);

create index if not exists idx_restrooms_source_id
  on public.restrooms(source_id);

create index if not exists idx_restrooms_publication_status
  on public.restrooms(publication_status);

create index if not exists idx_restrooms_coords
  on public.restrooms(latitude, longitude)
  where latitude is not null and longitude is not null;

create index if not exists idx_restrooms_type
  on public.restrooms(type);

drop trigger if exists set_restrooms_updated_at on public.restrooms;
create trigger set_restrooms_updated_at
  before update on public.restrooms
  for each row
  execute function public.handle_updated_at();

-- ============================================================================
-- 3. RESTROOM HOURS & EXCEPTIONS (docs/03_DATA_MODEL.md lines 210-235)
-- ============================================================================

-- 3.1 restroom_hours — 화장실 이용가능 시간 (요일별 복수 구간 허용)
create table if not exists public.restroom_hours (
  id uuid primary key default gen_random_uuid(),
  restroom_id uuid not null references public.restrooms(id) on delete cascade,
  weekday smallint not null check (weekday >= 0 and weekday <= 6),
  opens_at time null,
  closes_at time null,
  is_closed boolean not null default false,
  crosses_midnight boolean not null default false,
  constraint chk_restroom_hours_time check (
    is_closed = true or (opens_at is not null and closes_at is not null)
  )
);

create index if not exists idx_restroom_hours_restroom_weekday
  on public.restroom_hours(restroom_id, weekday);

-- 3.2 restroom_hour_exceptions — 특별 휴무/임시 운영
create table if not exists public.restroom_hour_exceptions (
  id uuid primary key default gen_random_uuid(),
  restroom_id uuid not null references public.restrooms(id) on delete cascade,
  exception_date date not null,
  is_closed boolean not null default false,
  opens_at time null,
  closes_at time null,
  reason text null check (reason is null or char_length(reason) <= 500),
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chk_restroom_hour_exceptions_time check (
    is_closed = true or (opens_at is not null and closes_at is not null)
  )
);

create index if not exists idx_restroom_hour_exceptions_date
  on public.restroom_hour_exceptions(restroom_id, exception_date);

-- ============================================================================
-- 4. RESTROOM ACCESS POLICIES & PHOTOS (docs/03_DATA_MODEL.md lines 236-265)
-- ============================================================================

-- 4.1 restroom_access_policies — 버전 있는 이용조건
create table if not exists public.restroom_access_policies (
  id uuid primary key default gen_random_uuid(),
  restroom_id uuid not null references public.restrooms(id) on delete cascade,
  version integer not null default 1 check (version >= 1),
  access_mode text not null check (access_mode in ('free', 'test_deposit', 'real_deposit')),
  deposit_amount_krw integer null check (deposit_amount_krw is null or deposit_amount_krw >= 0),
  refund_eligible boolean not null default false,
  receipt_window_hours integer null check (receipt_window_hours is null or receipt_window_hours > 0),
  min_purchase_krw integer null check (min_purchase_krw is null or min_purchase_krw >= 0),
  is_active boolean not null default false,
  effective_from timestamptz not null default now(),
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (restroom_id, version)
);

-- Exactly one active policy per restroom
create unique index if not exists idx_restroom_access_policies_single_active
  on public.restroom_access_policies(restroom_id)
  where is_active = true;

create index if not exists idx_restroom_access_policies_restroom
  on public.restroom_access_policies(restroom_id);

-- Policy enforcement trigger:
-- 1) Public restroom policy MUST be free with zero deposit and refund_eligible=false.
-- 2) Real deposit mode is strictly prohibited (test environment only).
-- 3) Free policy cannot have deposit > 0; deposit policy must have deposit > 0.
create or replace function public.enforce_restroom_access_policy_rules()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_restroom_type text;
begin
  select r.type into v_restroom_type
  from public.restrooms r
  where r.id = NEW.restroom_id;

  if v_restroom_type is null then
    raise exception 'Target restroom does not exist' using errcode = '23503';
  end if;

  -- Real money deposit is strictly prohibited in development/test
  if NEW.access_mode = 'real_deposit' then
    raise exception 'Forbidden: real_deposit access mode is not permitted'
      using errcode = '42501';
  end if;

  if v_restroom_type = 'public' then
    if NEW.access_mode <> 'free'
       or coalesce(NEW.deposit_amount_krw, 0) > 0
       or NEW.refund_eligible = true then
      raise exception 'Forbidden: public restrooms must have free access mode with zero deposit and no refund'
        using errcode = '42501';
    end if;
  end if;

  if NEW.access_mode = 'free' then
    if coalesce(NEW.deposit_amount_krw, 0) > 0 then
      raise exception 'Forbidden: free access mode cannot require a positive deposit'
        using errcode = 'HM005';
    end if;
  elsif NEW.access_mode = 'test_deposit' then
    if coalesce(NEW.deposit_amount_krw, 0) <= 0 then
      raise exception 'Forbidden: test_deposit mode requires deposit_amount_krw > 0'
        using errcode = 'HM005';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_restroom_access_policy_rules on public.restroom_access_policies;
create trigger trg_enforce_restroom_access_policy_rules
  before insert or update on public.restroom_access_policies
  for each row
  execute function public.enforce_restroom_access_policy_rules();

-- 4.2 restroom_photos — 전시 가능한 검수 사진
create table if not exists public.restroom_photos (
  id uuid primary key default gen_random_uuid(),
  restroom_id uuid not null references public.restrooms(id) on delete cascade,
  storage_path text not null check (char_length(trim(storage_path)) > 0 and char_length(storage_path) <= 500),
  photo_type text not null default 'other' check (
    photo_type in ('exterior', 'entrance', 'interior', 'signage', 'other')
  ),
  is_primary boolean not null default false,
  moderation_status text not null default 'pending' check (
    moderation_status in ('pending', 'approved', 'rejected')
  ),
  uploaded_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- At most one primary photo per restroom
create unique index if not exists idx_restroom_photos_single_primary
  on public.restroom_photos(restroom_id)
  where is_primary = true;

create index if not exists idx_restroom_photos_restroom
  on public.restroom_photos(restroom_id);

-- ============================================================================
-- 5. HELPER FUNCTIONS & UPDATE/INSERT TRIGGERS (SECURITY DEFINER)
-- ============================================================================

-- Helper: Check if caller can edit the restroom
create or replace function public.can_edit_restroom(p_restroom_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    public.is_admin(auth.uid())
    or exists (
      select 1
      from public.restrooms r
      where r.id = p_restroom_id
        and r.type = 'partner'
        and public.can_edit_business(r.business_id)
    ),
    false
  );
$$;

-- Helper: Check if caller is a member of the partner restroom's business
create or replace function public.is_restroom_business_member(p_restroom_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    public.is_admin(auth.uid())
    or exists (
      select 1
      from public.restrooms r
      where r.id = p_restroom_id
        and r.type = 'partner'
        and public.is_business_member(r.business_id, false)
    ),
    false
  );
$$;

-- Helper: Check if a partner business is approved (active & not suspended/rejected/draft)
create or replace function public.is_partner_business_approved(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    exists (
      select 1
      from public.businesses b
      where b.id = p_business_id
        and b.registration_status = 'approved'
    ),
    false
  );
$$;

-- Helper: Check if a restroom is publicly visible (published, and if partner, business must be approved)
create or replace function public.is_restroom_publicly_visible(
  p_type text,
  p_business_id uuid,
  p_publication_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_publication_status <> 'published' then false
    when p_type = 'public' then true
    when p_type = 'partner' then public.is_partner_business_approved(p_business_id)
    else false
  end;
$$;

-- Overload: Check public visibility by restroom ID for child tables
create or replace function public.is_restroom_publicly_visible(p_restroom_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    exists (
      select 1
      from public.restrooms r
      where r.id = p_restroom_id
        and public.is_restroom_publicly_visible(r.type, r.business_id, r.publication_status)
    ),
    false
  );
$$;

revoke all on function public.can_edit_restroom(uuid) from public, anon, authenticated;
revoke all on function public.is_restroom_business_member(uuid) from public, anon, authenticated;
revoke all on function public.is_partner_business_approved(uuid) from public, anon, authenticated;
revoke all on function public.is_restroom_publicly_visible(text, uuid, text) from public, anon, authenticated;
revoke all on function public.is_restroom_publicly_visible(uuid) from public, anon, authenticated;

grant execute on function public.can_edit_restroom(uuid) to authenticated, service_role;
grant execute on function public.is_restroom_business_member(uuid) to authenticated, service_role;
grant execute on function public.is_partner_business_approved(uuid) to anon, authenticated, service_role;
grant execute on function public.is_restroom_publicly_visible(text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.is_restroom_publicly_visible(uuid) to anon, authenticated, service_role;

-- Trigger: Enforce restroom update rules for regular users
create or replace function public.enforce_restroom_update_rules()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Future verification timestamp check for all roles (including admin and service_role)
  if NEW.last_verified_at is not null and NEW.last_verified_at > now() then
    raise exception 'Invalid timestamp: last_verified_at cannot be in the future'
      using errcode = '22007';
  end if;

  if current_user in ('anon', 'authenticated') then
    -- Immutable columns: id, created_by, created_at, type, business_id, source_id, source_record_id
    if NEW.id is distinct from OLD.id
       or NEW.created_by is distinct from OLD.created_by
       or NEW.created_at is distinct from OLD.created_at
       or NEW.type is distinct from OLD.type
       or NEW.business_id is distinct from OLD.business_id
       or NEW.source_id is distinct from OLD.source_id
       or NEW.source_record_id is distinct from OLD.source_record_id then
      raise exception 'Forbidden: identity, origin, and classification columns cannot be altered'
        using errcode = '42501';
    end if;

    -- Non-admins cannot alter publication status, approved_by, or last_verified_at
    if not public.is_admin(auth.uid()) then
      if NEW.publication_status is distinct from OLD.publication_status
         or NEW.approved_by is distinct from OLD.approved_by
         or NEW.last_verified_at is distinct from OLD.last_verified_at then
        raise exception 'Forbidden: publication status, approval, and verification timestamp can only be managed by administrators'
          using errcode = '42501';
      end if;

      -- If published, core location/identity cannot be changed without re-review
      if OLD.publication_status = 'published' then
        if NEW.name is distinct from OLD.name
           or NEW.road_address is distinct from OLD.road_address
           or NEW.latitude is distinct from OLD.latitude
           or NEW.longitude is distinct from OLD.longitude then
          raise exception 'Forbidden: core address and coordinates of a published restroom cannot be changed directly'
            using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_restrooms_update_rules on public.restrooms;
create trigger trg_enforce_restrooms_update_rules
  before update on public.restrooms
  for each row
  execute function public.enforce_restroom_update_rules();

-- Trigger: Enforce restroom insert rules for regular users
create or replace function public.enforce_restroom_insert_rules()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Future verification timestamp check for all roles (including admin and service_role)
  if NEW.last_verified_at is not null and NEW.last_verified_at > now() then
    raise exception 'Invalid timestamp: last_verified_at cannot be in the future'
      using errcode = '22007';
  end if;

  if current_user in ('anon', 'authenticated') then
    if NEW.type = 'public' and not public.is_admin(auth.uid()) then
      raise exception 'Forbidden: only administrators can register public restrooms'
        using errcode = '42501';
    end if;

    if NEW.type = 'partner' then
      if not public.is_approved_business_member(NEW.business_id, false)
         and not public.is_admin(auth.uid()) then
        raise exception 'Forbidden: only members of approved businesses can register partner restrooms'
          using errcode = '42501';
      end if;

      if not public.is_admin(auth.uid()) then
        if NEW.publication_status not in ('draft', 'pending') then
          raise exception 'Forbidden: partner restrooms must start in draft or pending status'
            using errcode = '42501';
        end if;
        if NEW.approved_by is not null or NEW.last_verified_at is not null then
          raise exception 'Forbidden: approved_by and last_verified_at cannot be assigned by non-administrators'
            using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_restrooms_insert_rules on public.restrooms;
create trigger trg_enforce_restrooms_insert_rules
  before insert on public.restrooms
  for each row
  execute function public.enforce_restroom_insert_rules();

-- Trigger: Enforce photo mutation rules and admin moderation protection
create or replace function public.enforce_restroom_photos_rules()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if TG_OP = 'INSERT' then
      if not public.is_admin(auth.uid()) then
        if NEW.moderation_status is distinct from 'pending' then
          raise exception 'Forbidden: merchants cannot self-approve photos'
            using errcode = '42501';
        end if;
        if NEW.uploaded_by is distinct from auth.uid() then
          raise exception 'Forbidden: uploaded_by must match authenticated user'
            using errcode = '42501';
        end if;
        if not public.can_edit_restroom(NEW.restroom_id) then
          raise exception 'Forbidden: no permission to upload photo for this restroom'
            using errcode = '42501';
        end if;
      end if;
    elsif TG_OP = 'UPDATE' then
      if not public.is_admin(auth.uid()) then
        if NEW.id is distinct from OLD.id
           or NEW.restroom_id is distinct from OLD.restroom_id
           or NEW.uploaded_by is distinct from OLD.uploaded_by
           or NEW.created_at is distinct from OLD.created_at then
          raise exception 'Forbidden: photo identity, restroom target, and ownership are immutable'
            using errcode = '42501';
        end if;

        if NEW.moderation_status is distinct from OLD.moderation_status then
          raise exception 'Forbidden: photo moderation status can only be changed by administrators'
            using errcode = '42501';
        end if;

        if OLD.moderation_status <> 'pending' then
          raise exception 'Forbidden: only pending photos can be modified by merchants'
            using errcode = '42501';
        end if;

        if not public.can_edit_restroom(NEW.restroom_id) then
          raise exception 'Forbidden: no permission to modify photo for this restroom'
            using errcode = '42501';
        end if;
      end if;
    elsif TG_OP = 'DELETE' then
      if not public.is_admin(auth.uid()) then
        if OLD.moderation_status <> 'pending' then
          raise exception 'Forbidden: only pending photos can be deleted by merchants'
            using errcode = '42501';
        end if;
        if not public.can_edit_restroom(OLD.restroom_id) then
          raise exception 'Forbidden: no permission to delete photo for this restroom'
            using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists trg_enforce_restroom_photos_rules on public.restroom_photos;
create trigger trg_enforce_restroom_photos_rules
  before insert or update or delete on public.restroom_photos
  for each row
  execute function public.enforce_restroom_photos_rules();

-- ============================================================================
-- 6. PERMISSIONS & ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on all tables
alter table public.public_data_sources enable row level security;
alter table public.public_import_runs enable row level security;
alter table public.restrooms enable row level security;
alter table public.restroom_hours enable row level security;
alter table public.restroom_hour_exceptions enable row level security;
alter table public.restroom_access_policies enable row level security;
alter table public.restroom_photos enable row level security;

-- Default-deny and GRANT structure
revoke all on public.public_data_sources from public, anon, authenticated;
grant select on public.public_data_sources to anon, authenticated;
grant insert, update, delete on public.public_data_sources to authenticated;
grant all on public.public_data_sources to service_role;

revoke all on public.public_import_runs from public, anon, authenticated;
grant select, insert, update, delete on public.public_import_runs to authenticated;
grant all on public.public_import_runs to service_role;

revoke all on public.restrooms from public, anon, authenticated;
grant select on public.restrooms to anon, authenticated;
grant insert on public.restrooms to authenticated;
grant update (
  name, description, road_address, address_detail, latitude, longitude,
  floor, entrance_instructions, gender_type, wheelchair_accessible,
  baby_changing_available, sanitary_products_available, access_method,
  publication_status, approved_by, last_verified_at
) on public.restrooms to authenticated;
grant delete on public.restrooms to authenticated;
grant all on public.restrooms to service_role;

revoke all on public.restroom_hours from public, anon, authenticated;
grant select on public.restroom_hours to anon, authenticated;
grant select, insert, update, delete on public.restroom_hours to authenticated;
grant all on public.restroom_hours to service_role;

revoke all on public.restroom_hour_exceptions from public, anon, authenticated;
grant select on public.restroom_hour_exceptions to anon, authenticated;
grant select, insert, update, delete on public.restroom_hour_exceptions to authenticated;
grant all on public.restroom_hour_exceptions to service_role;

revoke all on public.restroom_access_policies from public, anon, authenticated;
grant select on public.restroom_access_policies to anon, authenticated;
grant insert, update on public.restroom_access_policies to authenticated;
grant all on public.restroom_access_policies to service_role;

revoke all on public.restroom_photos from public, anon, authenticated;
grant select on public.restroom_photos to anon, authenticated;
grant insert, update, delete on public.restroom_photos to authenticated;
grant all on public.restroom_photos to service_role;

-- 6.1 public_data_sources policies
drop policy if exists "public_data_sources_select_policy" on public.public_data_sources;
create policy "public_data_sources_select_policy"
  on public.public_data_sources
  for select
  to anon, authenticated
  using (true);

drop policy if exists "public_data_sources_admin_mutation_policy" on public.public_data_sources;
create policy "public_data_sources_admin_mutation_policy"
  on public.public_data_sources
  for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- 6.2 public_import_runs policies (admin only)
drop policy if exists "public_import_runs_admin_policy" on public.public_import_runs;
create policy "public_import_runs_admin_policy"
  on public.public_import_runs
  for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- 6.3 restrooms policies (Split into anon and authenticated to avoid function permission issues)
drop policy if exists "restrooms_select_anon" on public.restrooms;
create policy "restrooms_select_anon"
  on public.restrooms
  for select
  to anon
  using (public.is_restroom_publicly_visible(type, business_id, publication_status));

drop policy if exists "restrooms_select_authenticated" on public.restrooms;
create policy "restrooms_select_authenticated"
  on public.restrooms
  for select
  to authenticated
  using (
    public.is_restroom_publicly_visible(type, business_id, publication_status)
    or public.is_admin(auth.uid())
    or (type = 'partner' and public.is_business_member(business_id, false))
  );

drop policy if exists "restrooms_insert_policy" on public.restrooms;
create policy "restrooms_insert_policy"
  on public.restrooms
  for insert
  to authenticated
  with check (
    public.is_admin(auth.uid())
    or (type = 'partner' and public.is_approved_business_member(business_id, false))
  );

drop policy if exists "restrooms_update_policy" on public.restrooms;
create policy "restrooms_update_policy"
  on public.restrooms
  for update
  to authenticated
  using (
    public.is_admin(auth.uid())
    or (type = 'partner' and public.can_edit_business(business_id))
  )
  with check (
    public.is_admin(auth.uid())
    or (type = 'partner' and public.can_edit_business(business_id))
  );

drop policy if exists "restrooms_delete_policy" on public.restrooms;
create policy "restrooms_delete_policy"
  on public.restrooms
  for delete
  to authenticated
  using (
    public.is_admin(auth.uid())
    or (
      type = 'partner'
      and publication_status = 'draft'
      and public.can_edit_business(business_id)
    )
  );

-- 6.4 restroom_hours policies
drop policy if exists "restroom_hours_select_anon" on public.restroom_hours;
create policy "restroom_hours_select_anon"
  on public.restroom_hours
  for select
  to anon
  using (public.is_restroom_publicly_visible(restroom_id));

drop policy if exists "restroom_hours_select_authenticated" on public.restroom_hours;
create policy "restroom_hours_select_authenticated"
  on public.restroom_hours
  for select
  to authenticated
  using (
    public.is_restroom_publicly_visible(restroom_id)
    or public.is_admin(auth.uid())
    or public.is_restroom_business_member(restroom_id)
  );

drop policy if exists "restroom_hours_mutation_policy" on public.restroom_hours;
create policy "restroom_hours_mutation_policy"
  on public.restroom_hours
  for all
  to authenticated
  using (public.can_edit_restroom(restroom_id))
  with check (public.can_edit_restroom(restroom_id));

-- 6.5 restroom_hour_exceptions policies
drop policy if exists "restroom_hour_exceptions_select_anon" on public.restroom_hour_exceptions;
create policy "restroom_hour_exceptions_select_anon"
  on public.restroom_hour_exceptions
  for select
  to anon
  using (public.is_restroom_publicly_visible(restroom_id));

drop policy if exists "restroom_hour_exceptions_select_authenticated" on public.restroom_hour_exceptions;
create policy "restroom_hour_exceptions_select_authenticated"
  on public.restroom_hour_exceptions
  for select
  to authenticated
  using (
    public.is_restroom_publicly_visible(restroom_id)
    or public.is_admin(auth.uid())
    or public.is_restroom_business_member(restroom_id)
  );

drop policy if exists "restroom_hour_exceptions_mutation_policy" on public.restroom_hour_exceptions;
create policy "restroom_hour_exceptions_mutation_policy"
  on public.restroom_hour_exceptions
  for all
  to authenticated
  using (public.can_edit_restroom(restroom_id))
  with check (public.can_edit_restroom(restroom_id));

-- 6.6 restroom_access_policies policies
drop policy if exists "restroom_access_policies_select_anon" on public.restroom_access_policies;
create policy "restroom_access_policies_select_anon"
  on public.restroom_access_policies
  for select
  to anon
  using (
    is_active = true
    and public.is_restroom_publicly_visible(restroom_id)
  );

drop policy if exists "restroom_access_policies_select_authenticated" on public.restroom_access_policies;
create policy "restroom_access_policies_select_authenticated"
  on public.restroom_access_policies
  for select
  to authenticated
  using (
    (
      is_active = true
      and public.is_restroom_publicly_visible(restroom_id)
    )
    or public.is_admin(auth.uid())
    or public.is_restroom_business_member(restroom_id)
  );

drop policy if exists "restroom_access_policies_insert_policy" on public.restroom_access_policies;
create policy "restroom_access_policies_insert_policy"
  on public.restroom_access_policies
  for insert
  to authenticated
  with check (
    public.is_admin(auth.uid())
    or exists (
      select 1
      from public.restrooms r
      where r.id = restroom_access_policies.restroom_id
        and r.type = 'partner'
        and public.is_approved_business_member(r.business_id, false)
    )
  );

drop policy if exists "restroom_access_policies_update_policy" on public.restroom_access_policies;
create policy "restroom_access_policies_update_policy"
  on public.restroom_access_policies
  for update
  to authenticated
  using (
    public.is_admin(auth.uid())
    or exists (
      select 1
      from public.restrooms r
      where r.id = restroom_access_policies.restroom_id
        and r.type = 'partner'
        and public.is_approved_business_member(r.business_id, false)
    )
  )
  with check (
    public.is_admin(auth.uid())
    or exists (
      select 1
      from public.restrooms r
      where r.id = restroom_access_policies.restroom_id
        and r.type = 'partner'
        and public.is_approved_business_member(r.business_id, false)
    )
  );

-- 6.7 restroom_photos policies
drop policy if exists "restroom_photos_select_anon" on public.restroom_photos;
create policy "restroom_photos_select_anon"
  on public.restroom_photos
  for select
  to anon
  using (
    moderation_status = 'approved'
    and public.is_restroom_publicly_visible(restroom_id)
  );

drop policy if exists "restroom_photos_select_authenticated" on public.restroom_photos;
create policy "restroom_photos_select_authenticated"
  on public.restroom_photos
  for select
  to authenticated
  using (
    (
      moderation_status = 'approved'
      and public.is_restroom_publicly_visible(restroom_id)
    )
    or public.is_admin(auth.uid())
    or uploaded_by = auth.uid()
    or public.is_restroom_business_member(restroom_id)
  );

drop policy if exists "restroom_photos_insert_policy" on public.restroom_photos;
create policy "restroom_photos_insert_policy"
  on public.restroom_photos
  for insert
  to authenticated
  with check (
    public.is_admin(auth.uid())
    or (
      moderation_status = 'pending'
      and uploaded_by = auth.uid()
      and public.can_edit_restroom(restroom_id)
    )
  );

drop policy if exists "restroom_photos_update_policy" on public.restroom_photos;
create policy "restroom_photos_update_policy"
  on public.restroom_photos
  for update
  to authenticated
  using (
    public.is_admin(auth.uid())
    or (
      moderation_status = 'pending'
      and (uploaded_by = auth.uid() or public.can_edit_restroom(restroom_id))
      and public.can_edit_restroom(restroom_id)
    )
  )
  with check (
    public.is_admin(auth.uid())
    or (
      moderation_status = 'pending'
      and (uploaded_by = auth.uid() or public.can_edit_restroom(restroom_id))
      and public.can_edit_restroom(restroom_id)
    )
  );

drop policy if exists "restroom_photos_delete_policy" on public.restroom_photos;
create policy "restroom_photos_delete_policy"
  on public.restroom_photos
  for delete
  to authenticated
  using (
    public.is_admin(auth.uid())
    or (
      moderation_status = 'pending'
      and (uploaded_by = auth.uid() or public.can_edit_restroom(restroom_id))
      and public.can_edit_restroom(restroom_id)
    )
  );
