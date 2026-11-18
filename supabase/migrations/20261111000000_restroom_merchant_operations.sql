-- Migration: 20261111000000_restroom_merchant_operations.sql
-- Purpose: TASK 12 Hardening — Atomic merchant restroom operations & policy immutability
--          1) Policy immutability trigger (blocks mutating history, version, deposit, etc.)
--          2) Atomic RPC: create_merchant_restroom (restroom + policy v1 in 1 transaction)
--          3) Atomic RPC: create_merchant_restroom_policy (deactivate old + insert next version with FOR UPDATE row lock)
--          4) Atomic RPC: submit_merchant_restroom_for_review (draft -> pending only, checks ownership & completeness)
-- Reference: tasks/12_restroom_merchant_api.md, docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/11_DECISIONS.md

-- ============================================================================
-- 1. ACCESS POLICY IMMUTABILITY TRIGGER & RLS HARDENING
-- ============================================================================

-- Tighten RLS insert policy on restroom_access_policies:
-- Direct INSERT is restricted to administrators only.
-- Regular merchants MUST use the dedicated SECURITY DEFINER RPCs:
--   - create_merchant_restroom()
--   - create_merchant_restroom_policy()
drop policy if exists "restroom_access_policies_insert_policy" on public.restroom_access_policies;
create policy "restroom_access_policies_insert_policy"
  on public.restroom_access_policies
  for insert
  to authenticated
  with check (
    public.is_admin(auth.uid())
  );

-- Defense-in-depth trigger: blocks direct INSERT and UPDATE by non-admin callers
create or replace function public.enforce_restroom_access_policy_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if not public.is_admin(auth.uid()) then
      -- Direct INSERT or UPDATE on access policies by non-admins is completely forbidden.
      -- Creating initial policies or transitioning to new versions must be executed atomically
      -- via dedicated SECURITY DEFINER RPCs (create_merchant_restroom, create_merchant_restroom_policy).
      -- This strictly prevents non-admins from forging policies, setting arbitrary versions,
      -- injecting false created_by/effective_from timestamps, deactivating active policies,
      -- or directly tampering with deposit amounts outside audited RPC logic.
      raise exception 'Forbidden: direct modification of access policies is prohibited. Use create_merchant_restroom or create_merchant_restroom_policy'
        using errcode = '42501';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_restroom_access_policy_mutation on public.restroom_access_policies;
create trigger trg_enforce_restroom_access_policy_mutation
  before insert or update on public.restroom_access_policies
  for each row
  execute function public.enforce_restroom_access_policy_mutation();

-- ============================================================================
-- 2. ATOMIC RPC: create_merchant_restroom
-- ============================================================================

create or replace function public.create_merchant_restroom(
  p_business_id uuid,
  p_name text,
  p_description text default null,
  p_road_address text default null,
  p_address_detail text default null,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_floor text default null,
  p_entrance_instructions text default null,
  p_gender_type text default 'unknown',
  p_wheelchair_accessible boolean default null,
  p_baby_changing_available boolean default null,
  p_sanitary_products_available boolean default null,
  p_access_method text default 'ask_staff',
  p_access_mode text default 'test_deposit',
  p_deposit_amount_krw integer default 1000,
  p_refund_eligible boolean default true,
  p_receipt_window_hours integer default 24,
  p_min_purchase_krw integer default 0
)
returns public.restrooms
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_restroom public.restrooms;
  v_actual_deposit integer;
  v_actual_refund boolean;
  v_actual_receipt_window integer;
  v_actual_min_purchase integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Unauthorized' using errcode = '42501';
  end if;

  -- Verify store membership and approval
  if not public.is_admin(v_uid) and not public.is_approved_business_member(p_business_id, false) then
    raise exception 'Forbidden: caller is not an active member of this approved business'
      using errcode = '42501';
  end if;

  -- Validate name and address
  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'Restroom name is required' using errcode = '22000';
  end if;
  if p_road_address is null or char_length(trim(p_road_address)) = 0 then
    raise exception 'Road address is required' using errcode = '22000';
  end if;

  -- Validate access mode
  if p_access_mode not in ('free', 'test_deposit') then
    raise exception 'Forbidden: access mode must be free or test_deposit' using errcode = '42501';
  end if;

  if p_access_mode = 'free' then
    v_actual_deposit := 0;
    v_actual_refund := false;
    v_actual_receipt_window := null;
    v_actual_min_purchase := 0;
  else
    v_actual_deposit := coalesce(p_deposit_amount_krw, 1000);
    if v_actual_deposit <= 0 then
      raise exception 'test_deposit requires positive deposit amount' using errcode = 'HM005';
    end if;
    v_actual_refund := coalesce(p_refund_eligible, true);
    v_actual_receipt_window := coalesce(p_receipt_window_hours, 24);
    v_actual_min_purchase := coalesce(p_min_purchase_krw, 0);
  end if;

  -- 1. Insert restroom as draft
  insert into public.restrooms (
    business_id,
    source_id,
    source_record_id,
    type,
    name,
    description,
    road_address,
    address_detail,
    latitude,
    longitude,
    floor,
    entrance_instructions,
    gender_type,
    wheelchair_accessible,
    baby_changing_available,
    sanitary_products_available,
    access_method,
    publication_status,
    last_verified_at,
    created_by,
    approved_by
  ) values (
    p_business_id,
    null,
    null,
    'partner',
    trim(p_name),
    trim(p_description),
    trim(p_road_address),
    trim(p_address_detail),
    p_latitude,
    p_longitude,
    trim(p_floor),
    trim(p_entrance_instructions),
    coalesce(p_gender_type, 'unknown'),
    p_wheelchair_accessible,
    p_baby_changing_available,
    p_sanitary_products_available,
    coalesce(p_access_method, 'ask_staff'),
    'draft',
    null,
    v_uid,
    null
  ) returning * into v_restroom;

  -- 2. Insert initial access policy (version 1)
  insert into public.restroom_access_policies (
    restroom_id,
    version,
    access_mode,
    deposit_amount_krw,
    refund_eligible,
    receipt_window_hours,
    min_purchase_krw,
    is_active,
    effective_from,
    created_by
  ) values (
    v_restroom.id,
    1,
    p_access_mode,
    v_actual_deposit,
    v_actual_refund,
    v_actual_receipt_window,
    v_actual_min_purchase,
    true,
    now(),
    v_uid
  );

  return v_restroom;
end;
$$;

revoke all on function public.create_merchant_restroom(uuid, text, text, text, text, double precision, double precision, text, text, text, boolean, boolean, boolean, text, text, integer, boolean, integer, integer) from public, anon;
grant execute on function public.create_merchant_restroom(uuid, text, text, text, text, double precision, double precision, text, text, text, boolean, boolean, boolean, text, text, integer, boolean, integer, integer) to authenticated, service_role;

-- ============================================================================
-- 3. ATOMIC RPC: create_merchant_restroom_policy
-- ============================================================================

create or replace function public.create_merchant_restroom_policy(
  p_restroom_id uuid,
  p_access_mode text,
  p_deposit_amount_krw integer default 1000,
  p_refund_eligible boolean default true,
  p_receipt_window_hours integer default 24,
  p_min_purchase_krw integer default 0
)
returns public.restroom_access_policies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_restroom public.restrooms;
  v_next_version integer;
  v_new_policy public.restroom_access_policies;
  v_actual_deposit integer;
  v_actual_refund boolean;
  v_actual_receipt_window integer;
  v_actual_min_purchase integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Unauthorized' using errcode = '42501';
  end if;

  -- Lock restroom row to eliminate concurrent race condition
  select * into v_restroom
  from public.restrooms
  where id = p_restroom_id
  for update;

  if v_restroom.id is null then
    raise exception 'Restroom not found' using errcode = 'P0002';
  end if;

  if v_restroom.type <> 'partner' then
    raise exception 'Forbidden: cannot create access policy for public restroom'
      using errcode = '42501';
  end if;

  if not public.is_admin(v_uid) and not public.is_approved_business_member(v_restroom.business_id, false) then
    raise exception 'Forbidden: caller is not an active member of this approved business'
      using errcode = '42501';
  end if;

  if p_access_mode not in ('free', 'test_deposit') then
    raise exception 'Forbidden: access mode must be free or test_deposit' using errcode = '42501';
  end if;

  if p_access_mode = 'free' then
    v_actual_deposit := 0;
    v_actual_refund := false;
    v_actual_receipt_window := null;
    v_actual_min_purchase := 0;
  else
    v_actual_deposit := coalesce(p_deposit_amount_krw, 1000);
    if v_actual_deposit <= 0 then
      raise exception 'test_deposit requires positive deposit amount' using errcode = 'HM005';
    end if;
    v_actual_refund := coalesce(p_refund_eligible, true);
    v_actual_receipt_window := coalesce(p_receipt_window_hours, 24);
    v_actual_min_purchase := coalesce(p_min_purchase_krw, 0);
  end if;

  -- 1. Deactivate current active policy
  update public.restroom_access_policies
  set is_active = false
  where restroom_id = p_restroom_id
    and is_active = true;

  -- 2. Determine next version
  select coalesce(max(version), 0) + 1
  into v_next_version
  from public.restroom_access_policies
  where restroom_id = p_restroom_id;

  -- 3. Insert new policy
  insert into public.restroom_access_policies (
    restroom_id,
    version,
    access_mode,
    deposit_amount_krw,
    refund_eligible,
    receipt_window_hours,
    min_purchase_krw,
    is_active,
    effective_from,
    created_by
  ) values (
    p_restroom_id,
    v_next_version,
    p_access_mode,
    v_actual_deposit,
    v_actual_refund,
    v_actual_receipt_window,
    v_actual_min_purchase,
    true,
    now(),
    v_uid
  ) returning * into v_new_policy;

  return v_new_policy;
end;
$$;

revoke all on function public.create_merchant_restroom_policy(uuid, text, integer, boolean, integer, integer) from public, anon;
grant execute on function public.create_merchant_restroom_policy(uuid, text, integer, boolean, integer, integer) to authenticated, service_role;

-- ============================================================================
-- 4. ATOMIC RPC: submit_merchant_restroom_for_review
-- ============================================================================

create or replace function public.submit_merchant_restroom_for_review(
  p_restroom_id uuid
)
returns public.restrooms
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_restroom public.restrooms;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Unauthorized' using errcode = '42501';
  end if;

  -- Lock restroom row
  select * into v_restroom
  from public.restrooms
  where id = p_restroom_id
  for update;

  if v_restroom.id is null then
    raise exception 'Restroom not found' using errcode = 'P0002';
  end if;

  if v_restroom.type <> 'partner' then
    raise exception 'Forbidden: cannot submit public restroom for review'
      using errcode = '42501';
  end if;

  if not public.is_admin(v_uid) and not public.is_approved_business_member(v_restroom.business_id, false) then
    raise exception 'Forbidden: caller is not an active member of this approved business'
      using errcode = '42501';
  end if;

  if v_restroom.publication_status <> 'draft' then
    raise exception 'Only draft restrooms can be submitted for review (current status: %)', v_restroom.publication_status
      using errcode = 'HM001';
  end if;

  -- Completeness validation
  if v_restroom.name is null or char_length(trim(v_restroom.name)) = 0
     or v_restroom.road_address is null or char_length(trim(v_restroom.road_address)) = 0
     or v_restroom.latitude is null or v_restroom.longitude is null then
    raise exception 'Restroom name, address, and coordinates are required before review submission'
      using errcode = 'HM005';
  end if;

  if not exists (
    select 1 from public.restroom_access_policies
    where restroom_id = p_restroom_id
      and is_active = true
  ) then
    raise exception 'Restroom must have an active access policy before submission'
      using errcode = 'HM005';
  end if;

  -- Transition draft -> pending
  update public.restrooms
  set publication_status = 'pending',
      updated_at = now()
  where id = p_restroom_id
  returning * into v_restroom;

  return v_restroom;
end;
$$;

revoke all on function public.submit_merchant_restroom_for_review(uuid) from public, anon;
grant execute on function public.submit_merchant_restroom_for_review(uuid) to authenticated, service_role;

