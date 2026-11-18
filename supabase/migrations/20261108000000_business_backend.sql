-- Migration: 20261108000000_business_backend.sql
-- Purpose: TASK 06 / 06-A Business backend schema (businesses, business_members, business_verifications, business_hours)
--          with default-deny GRANTs, non-recursive RLS, protected approval columns and atomic registration RPCs.
-- Reference: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md, tasks/06_business_backend.md
--
-- Security model (TASK 06-A):
--   * Browser/REST (role `authenticated`) can NEVER insert businesses / business_members / business_verifications directly.
--     Registration goes through SECURITY DEFINER RPC `create_business_with_owner` (atomic: business + first owner + verification).
--   * Review submission goes through RPC `submit_business_for_review` (owner only, draft/rejected -> pending).
--   * `authenticated` may UPDATE only non-approval business columns (column-level GRANT) and a BEFORE UPDATE trigger
--     re-checks protected columns. (승인된 가게 수정 시 재심사/draft 전환 정책은 후속 결정 사항으로 분류되어 강제 전환하지 않음)
--   * Approval columns (registration_status, approved_by, approved_at, rejection_reason, created_by) are changed
--     only by service_role / SECURITY DEFINER server paths (TASK 08).
--   * business_verifications private columns (registration_number, evidence_storage_path, review_notes, reviewed_by)
--     are not SELECT-able by `authenticated` (column-level GRANT); admins read them through the server (service_role).
--   * RLS policies never query their own table directly; membership checks use SECURITY DEFINER helpers
--     that only answer about the calling user (auth.uid()), preventing recursion and UUID enumeration.
--   * Registering a business does not grant any user_roles row. Registration permission (any active authenticated user)
--     is separate from approved-business operation permission (is_approved_business_member).

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- 1.1 businesses — 제휴 가게 기본·승인 정보
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0 and char_length(name) <= 100),
  category text not null check (char_length(trim(category)) > 0 and char_length(category) <= 50),
  description text null check (description is null or char_length(description) <= 1000),
  road_address text not null check (char_length(trim(road_address)) > 0 and char_length(road_address) <= 200),
  jibun_address text null check (jibun_address is null or char_length(jibun_address) <= 200),
  address_detail text null check (address_detail is null or char_length(address_detail) <= 100),
  latitude double precision not null check (latitude >= -90 and latitude <= 90),
  longitude double precision not null check (longitude >= -180 and longitude <= 180),
  phone text null check (phone is null or char_length(phone) <= 30),
  website_url text null check (website_url is null or (char_length(website_url) <= 300 and website_url ~* '^https?://')),
  registration_status text not null default 'draft' check (
    registration_status in ('draft', 'pending', 'approved', 'rejected', 'suspended')
  ),
  created_by uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid null references public.profiles(id) on delete set null,
  approved_at timestamptz null,
  rejection_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_businesses_approved_has_time check (
    registration_status <> 'approved' or approved_at is not null
  ),
  constraint chk_businesses_unapproved_no_approval check (
    registration_status not in ('draft', 'pending') or (approved_by is null and approved_at is null)
  )
);

drop trigger if exists set_businesses_updated_at on public.businesses;
create trigger set_businesses_updated_at
  before update on public.businesses
  for each row
  execute function public.handle_updated_at();

create index if not exists idx_businesses_created_by
  on public.businesses(created_by);

create index if not exists idx_businesses_registration_status
  on public.businesses(registration_status);

create index if not exists idx_businesses_coords
  on public.businesses(latitude, longitude);

create index if not exists idx_businesses_created_at
  on public.businesses(created_at desc);

create index if not exists idx_businesses_approved_by
  on public.businesses(approved_by);

-- 1.2 business_members — 가게 계정 소속/역할
create table if not exists public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'manager')),
  membership_status text not null default 'active' check (
    membership_status in ('active', 'revoked')
  ),
  status text generated always as (membership_status) stored,
  joined_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create index if not exists idx_business_members_user_id
  on public.business_members(user_id);

-- 1.3 business_verifications — 가게 운영권한 인증 근거 (사업자등록번호·증빙은 private)
create table if not exists public.business_verifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  submitted_by uuid not null references public.profiles(id) on delete restrict,
  method text not null check (method in ('in_person', 'phone', 'document')),
  registration_number text null check (
    registration_number is null or registration_number ~ '^[0-9]{3}-?[0-9]{2}-?[0-9]{5}$'
  ),
  evidence_storage_path text null,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'rejected')
  ),
  reviewed_by uuid null references public.profiles(id) on delete set null,
  reviewed_at timestamptz null,
  review_notes text null,
  created_at timestamptz not null default now(),
  constraint chk_business_verifications_pending_unreviewed check (
    status <> 'pending' or (reviewed_by is null and reviewed_at is null)
  )
);

create index if not exists idx_business_verifications_business_id
  on public.business_verifications(business_id);

create index if not exists idx_business_verifications_submitted_by
  on public.business_verifications(submitted_by);

create index if not exists idx_business_verifications_status
  on public.business_verifications(status);

create index if not exists idx_business_verifications_reviewed_by
  on public.business_verifications(reviewed_by);

-- 1.4 business_hours — 가게 영업시간 (화장실 개방시간과 별도)
create table if not exists public.business_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  weekday smallint not null check (weekday >= 0 and weekday <= 6),
  opens_at time null,
  closes_at time null,
  is_closed boolean not null default false,
  crosses_midnight boolean not null default false,
  constraint uq_business_hours_weekday unique (business_id, weekday),
  constraint chk_business_hours_time check (
    is_closed = true or (opens_at is not null and closes_at is not null)
  )
);

create index if not exists idx_business_hours_business_id
  on public.business_hours(business_id);

-- 1.5 Add Foreign Key constraint to business_leads.converted_business_id
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'business_leads'
  ) then
    if not exists (
      select 1 from information_schema.table_constraints
      where constraint_name = 'fk_business_leads_converted_business'
        and table_schema = 'public'
        and table_name = 'business_leads'
    ) then
      alter table public.business_leads
        add constraint fk_business_leads_converted_business
        foreign key (converted_business_id)
        references public.businesses(id)
        on delete set null;
    end if;
  end if;
end $$;

-- ============================================================================
-- 2. HELPER FUNCTIONS (SECURITY DEFINER, caller-only, no enumeration)
-- ============================================================================
-- These helpers read business_members / businesses bypassing RLS so that RLS policies on those
-- tables never reference themselves (avoids "infinite recursion detected in policy").
-- They only ever answer for auth.uid(); they accept no user id parameter.

create or replace function public.is_business_member(
  p_business_id uuid,
  p_owner_only boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    auth.uid() is not null
    and exists (
      select 1
      from public.business_members bm
      where bm.business_id = p_business_id
        and bm.user_id = auth.uid()
        and bm.membership_status = 'active'
        and (not p_owner_only or bm.role = 'owner')
    ),
    false
  );
$$;

-- Active member of an APPROVED business. Approved-only features (restrooms, PIN, access policies, ...)
-- must gate on this helper (or its server-side equivalent) rather than on user_roles alone.
create or replace function public.is_approved_business_member(
  p_business_id uuid,
  p_owner_only boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    public.is_business_member(p_business_id, p_owner_only)
    and exists (
      select 1
      from public.businesses b
      where b.id = p_business_id
        and b.registration_status = 'approved'
    ),
    false
  );
$$;

-- Active member of a business that is not suspended (suspended businesses cannot be edited by members).
create or replace function public.can_edit_business(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    public.is_business_member(p_business_id, false)
    and exists (
      select 1
      from public.businesses b
      where b.id = p_business_id
        and b.registration_status <> 'suspended'
    ),
    false
  );
$$;

revoke all on function public.is_business_member(uuid, boolean) from public, anon, authenticated;
revoke all on function public.is_approved_business_member(uuid, boolean) from public, anon, authenticated;
revoke all on function public.can_edit_business(uuid) from public, anon, authenticated;
grant execute on function public.is_business_member(uuid, boolean) to authenticated, service_role;
grant execute on function public.is_approved_business_member(uuid, boolean) to authenticated, service_role;
grant execute on function public.can_edit_business(uuid) to authenticated, service_role;

-- ============================================================================
-- 3. PROTECTED-COLUMN TRIGGER (defense in depth behind column-level GRANTs)
-- ============================================================================
-- SECURITY INVOKER on purpose: current_user is the session role for direct REST writes
-- ('authenticated'), and the function owner when called from our SECURITY DEFINER RPCs / service_role paths.

create or replace function public.enforce_business_update_rules()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if NEW.id is distinct from OLD.id
       or NEW.created_by is distinct from OLD.created_by
       or NEW.created_at is distinct from OLD.created_at
       or NEW.registration_status is distinct from OLD.registration_status
       or NEW.approved_by is distinct from OLD.approved_by
       or NEW.approved_at is distinct from OLD.approved_at
       or NEW.rejection_reason is distinct from OLD.rejection_reason then
      raise exception 'Forbidden: approval and ownership columns are server-managed'
        using errcode = '42501';
    end if;

    -- 승인된 가게의 핵심 승인 근거 정보(상호, 업종, 주소, 좌표) 무단 변경 차단:
    -- 재심사 정책이 확정되기 전까지 승인 근거 정보의 임의 변경을 방지하고 일반 정보(설명, 전화, 사이트)만 수정 허용.
    if OLD.registration_status = 'approved' and not public.is_admin(auth.uid()) then
      if NEW.name is distinct from OLD.name
         or NEW.category is distinct from OLD.category
         or NEW.road_address is distinct from OLD.road_address
         or NEW.jibun_address is distinct from OLD.jibun_address
         or NEW.address_detail is distinct from OLD.address_detail
         or NEW.latitude is distinct from OLD.latitude
         or NEW.longitude is distinct from OLD.longitude then
        raise exception 'Forbidden: core business identity (name, category, address, coordinates) of an approved business cannot be changed without re-review'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

revoke all on function public.enforce_business_update_rules() from public, anon, authenticated;

drop trigger if exists enforce_businesses_update_rules on public.businesses;
create trigger enforce_businesses_update_rules
  before update on public.businesses
  for each row
  execute function public.enforce_business_update_rules();

-- ============================================================================
-- 4. ATOMIC REGISTRATION RPCs (SECURITY DEFINER)
-- ============================================================================

-- 4.1 create_business_with_owner: business(draft) + first owner membership + optional verification in ONE transaction.
--     The first owner is always auth.uid() (the creator); callers cannot pass a user id or a status.
--     Does not touch user_roles. SQLSTATEs: 28000 unauthenticated, 42501 inactive account,
--     23xxx table constraint violations.
create or replace function public.create_business_with_owner(
  p_name text,
  p_category text,
  p_description text,
  p_road_address text,
  p_jibun_address text,
  p_address_detail text,
  p_latitude double precision,
  p_longitude double precision,
  p_phone text,
  p_website_url text,
  p_registration_number text
)
returns public.businesses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_account_status text;
  v_registration_number text := nullif(btrim(p_registration_number), '');
  v_business public.businesses;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select p.account_status into v_account_status
  from public.profiles p
  where p.id = v_uid;

  if v_account_status is distinct from 'active' then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;

  insert into public.businesses (
    name, category, description, road_address, jibun_address, address_detail,
    latitude, longitude, phone, website_url, registration_status, created_by
  )
  values (
    btrim(p_name),
    btrim(p_category),
    nullif(btrim(p_description), ''),
    btrim(p_road_address),
    nullif(btrim(p_jibun_address), ''),
    nullif(btrim(p_address_detail), ''),
    p_latitude,
    p_longitude,
    nullif(btrim(p_phone), ''),
    nullif(btrim(p_website_url), ''),
    'draft',
    v_uid
  )
  returning * into v_business;

  insert into public.business_members (business_id, user_id, role, membership_status)
  values (v_business.id, v_uid, 'owner', 'active');

  if v_registration_number is not null then
    insert into public.business_verifications (
      business_id, submitted_by, method, registration_number, status
    )
    values (v_business.id, v_uid, 'document', v_registration_number, 'pending');
  end if;

  return v_business;
end;
$$;

-- 4.2 submit_business_for_review: owner only, draft/rejected -> pending, row-locked.
--     SQLSTATEs: 28000 unauthenticated, 42501 not owner, P0002 not found,
--     HM001 already pending, HM002 already approved, HM003 suspended, HM005 other invalid state.
create or replace function public.submit_business_for_review(p_business_id uuid)
returns public.businesses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_business public.businesses;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if p_business_id is null or not public.is_business_member(p_business_id, true) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_business
  from public.businesses b
  where b.id = p_business_id
  for update;

  if not found then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_business.registration_status = 'pending' then
    raise exception 'BUSINESS_ALREADY_PENDING' using errcode = 'HM001';
  elsif v_business.registration_status = 'approved' then
    raise exception 'BUSINESS_ALREADY_APPROVED' using errcode = 'HM002';
  elsif v_business.registration_status = 'suspended' then
    raise exception 'BUSINESS_SUSPENDED' using errcode = 'HM003';
  elsif v_business.registration_status not in ('draft', 'rejected') then
    raise exception 'BUSINESS_INVALID_STATE' using errcode = 'HM005';
  end if;

  update public.businesses
  set registration_status = 'pending',
      rejection_reason = null
  where id = p_business_id
  returning * into v_business;

  return v_business;
end;
$$;

revoke all on function public.create_business_with_owner(
  text, text, text, text, text, text, double precision, double precision, text, text, text
) from public, anon, authenticated;
revoke all on function public.submit_business_for_review(uuid) from public, anon, authenticated;
grant execute on function public.create_business_with_owner(
  text, text, text, text, text, text, double precision, double precision, text, text, text
) to authenticated, service_role;
grant execute on function public.submit_business_for_review(uuid) to authenticated, service_role;

-- ============================================================================
-- 5. ROW LEVEL SECURITY (RLS) & PRIVILEGES
-- ============================================================================

alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.business_verifications enable row level security;
alter table public.business_hours enable row level security;

-- Default deny for public, anon, and authenticated
revoke all on public.businesses from public, anon, authenticated;
revoke all on public.business_members from public, anon, authenticated;
revoke all on public.business_verifications from public, anon, authenticated;
revoke all on public.business_hours from public, anon, authenticated;

-- service_role (server only)
grant select, insert, update on public.businesses to service_role;
grant select, insert, update on public.business_members to service_role;
grant select, insert, update on public.business_verifications to service_role;
grant select, insert, update, delete on public.business_hours to service_role;

-- authenticated: least privilege.
--   businesses: SELECT + UPDATE of non-approval columns only. No INSERT (use create_business_with_owner).
grant select on public.businesses to authenticated;
grant update (
  name, category, description, road_address, jibun_address, address_detail,
  latitude, longitude, phone, website_url
) on public.businesses to authenticated;

--   business_members: SELECT only. No direct INSERT/UPDATE/DELETE (owner registration via RPC; member admin is server-side).
grant select on public.business_members to authenticated;

--   business_verifications: SELECT of non-private columns only. No direct INSERT (RPC) and no private columns.
grant select (id, business_id, submitted_by, method, status, reviewed_at, created_at)
  on public.business_verifications to authenticated;

--   business_hours: member-managed rows.
grant select, insert, update, delete on public.business_hours to authenticated;

-- 5.1 businesses policies (members/admin only; public approved info is served by a server allowlist API)
drop policy if exists "businesses_select_policy" on public.businesses;
create policy "businesses_select_policy"
  on public.businesses
  for select
  to authenticated
  using (
    public.is_admin(auth.uid())
    or public.is_business_member(id, false)
  );

drop policy if exists "businesses_insert_policy" on public.businesses;
drop policy if exists "businesses_update_policy" on public.businesses;
create policy "businesses_update_policy"
  on public.businesses
  for update
  to authenticated
  using (
    public.is_admin(auth.uid())
    or public.can_edit_business(id)
  )
  with check (
    public.is_admin(auth.uid())
    or (
      public.is_business_member(id, false)
      and registration_status in ('draft', 'pending', 'approved', 'rejected')
    )
  );

-- 5.2 business_members policies (read-only for clients)
drop policy if exists "business_members_select_policy" on public.business_members;
create policy "business_members_select_policy"
  on public.business_members
  for select
  to authenticated
  using (
    public.is_admin(auth.uid())
    or user_id = auth.uid()
    or public.is_business_member(business_id, false)
  );

drop policy if exists "business_members_insert_policy" on public.business_members;
drop policy if exists "business_members_update_policy" on public.business_members;

-- 5.3 business_verifications policies (private; own submissions only, non-private columns via GRANT)
drop policy if exists "business_verifications_select_policy" on public.business_verifications;
create policy "business_verifications_select_policy"
  on public.business_verifications
  for select
  to authenticated
  using (
    public.is_admin(auth.uid())
    or (
      submitted_by = auth.uid()
      and public.is_business_member(business_id, false)
    )
  );

drop policy if exists "business_verifications_insert_policy" on public.business_verifications;

-- 5.4 business_hours policies
drop policy if exists "business_hours_select_policy" on public.business_hours;
create policy "business_hours_select_policy"
  on public.business_hours
  for select
  to authenticated
  using (
    public.is_admin(auth.uid())
    or public.is_business_member(business_id, false)
  );

drop policy if exists "business_hours_insert_policy" on public.business_hours;
create policy "business_hours_insert_policy"
  on public.business_hours
  for insert
  to authenticated
  with check (
    public.is_admin(auth.uid())
    or public.can_edit_business(business_id)
  );

drop policy if exists "business_hours_update_policy" on public.business_hours;
create policy "business_hours_update_policy"
  on public.business_hours
  for update
  to authenticated
  using (
    public.is_admin(auth.uid())
    or public.can_edit_business(business_id)
  )
  with check (
    public.is_admin(auth.uid())
    or public.can_edit_business(business_id)
  );

drop policy if exists "business_hours_delete_policy" on public.business_hours;
create policy "business_hours_delete_policy"
  on public.business_hours
  for delete
  to authenticated
  using (
    public.is_admin(auth.uid())
    or public.can_edit_business(business_id)
  );
