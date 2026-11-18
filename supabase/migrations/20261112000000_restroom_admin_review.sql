-- Migration: 20261112000000_restroom_admin_review.sql
-- Purpose: TASK 14 Administrator Restroom Review, Approval, Rejection, Suspension, and Audit Logging
-- Reference: tasks/14_restroom_admin_review.md, docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md

-- ============================================================================
-- 1. ATOMIC RESTROOM REVIEW DECISION RPC (SECURITY DEFINER)
-- ============================================================================
-- Enforces strictly defined publication status transitions:
--   - publish:
--       * Allowed from: 'pending' (initial approval), 'suspended' (re-publishing after suspension)
--       * Rejected from: 'published' (duplicate HM002), 'draft' (bypass review HM001), 'archived' (decommissioned HM001)
--       * Validates: non-empty name & road_address, valid non-null coordinates, approved partner business, active policy
--       * Sets: publication_status = 'published', approved_by = v_uid, last_verified_at = now()
--       * Writes: immutable audit_logs record
--   - reject:
--       * Allowed from: strictly 'pending'
--       * Rejected from: 'published' (inappropriate rejection HM001; must suspend), 'draft' (HM001), 'suspended' (HM001), 'archived' (HM001)
--       * Validates: non-empty rejection reason of at least 2 characters (HM006)
--       * Sets: publication_status = 'draft', approved_by = null
--       * Writes: immutable audit_logs record with rejection reason
--   - suspend:
--       * Allowed from: strictly 'published'
--       * Rejected from: 'suspended' (duplicate HM002), 'pending' (HM001), 'draft' (HM001), 'archived' (HM001)
--       * Validates: non-empty suspension reason of at least 2 characters (HM006)
--       * Sets: publication_status = 'suspended'
--       * Writes: immutable audit_logs record with suspension reason

create or replace function public.decide_restroom_review(
  p_restroom_id uuid,
  p_decision text,
  p_reason text default null,
  p_review_notes text default null
)
returns public.restrooms
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_decision text;
  v_reason text := nullif(btrim(p_reason), '');
  v_review_notes text := nullif(btrim(p_review_notes), '');
  v_restroom public.restrooms;
  v_before_data jsonb;
  v_after_data jsonb;
  v_active_policy_count integer;
  v_business_status text;
begin
  -- 1. Authentication & admin check (NULL-safe)
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if not public.is_admin(v_uid) then
    raise exception 'FORBIDDEN_NOT_ADMIN: administrator role required' using errcode = '42501';
  end if;

  -- 2. Validate decision parameter (strictly reject NULL and empty strings with 22023)
  if p_decision is null or btrim(p_decision) = '' then
    raise exception 'INVALID_DECISION: decision cannot be null or empty' using errcode = '22023';
  end if;

  v_decision := lower(btrim(p_decision));
  if v_decision not in ('publish', 'reject', 'suspend') then
    raise exception 'INVALID_DECISION: decision must be publish, reject, or suspend' using errcode = '22023';
  end if;

  -- 3. Lock restroom row FOR UPDATE
  select * into v_restroom
  from public.restrooms
  where id = p_restroom_id
  for update;

  if not found then
    raise exception 'RESTROOM_NOT_FOUND: restroom record does not exist' using errcode = 'P0002';
  end if;

  v_before_data := to_jsonb(v_restroom);

  -- 4. Process decision with strict publication status state-machine transitions
  if v_decision = 'publish' then
    -- 4.1 Duplicate check: already published
    if v_restroom.publication_status = 'published' then
      raise exception 'ALREADY_PUBLISHED: restroom is already published' using errcode = 'HM002';
    end if;

    -- 4.2 State transition check: only pending or suspended can be published
    if v_restroom.publication_status = 'draft' then
      raise exception 'INVALID_STATUS_TRANSITION: draft restroom cannot be published directly without review submission'
        using errcode = 'HM001';
    elsif v_restroom.publication_status = 'archived' then
      raise exception 'INVALID_STATUS_TRANSITION: archived restroom cannot be published'
        using errcode = 'HM001';
    elsif v_restroom.publication_status not in ('pending', 'suspended') then
      raise exception 'INVALID_STATUS_TRANSITION: invalid publication status for publish'
        using errcode = 'HM001';
    end if;

    -- 4.3 Required field completeness checks
    if coalesce(trim(v_restroom.name), '') = '' or coalesce(trim(v_restroom.road_address), '') = '' then
      raise exception 'INCOMPLETE_RESTROOM: name and road_address are required' using errcode = 'HM005';
    end if;

    if v_restroom.latitude is null or v_restroom.longitude is null then
      raise exception 'INCOMPLETE_RESTROOM: latitude and longitude are required' using errcode = 'HM005';
    end if;

    -- 4.4 Partner business approval validation
    if v_restroom.type = 'partner' then
      if v_restroom.business_id is null then
        raise exception 'INCOMPLETE_RESTROOM: partner restroom requires business_id' using errcode = 'HM005';
      end if;

      select registration_status into v_business_status
      from public.businesses
      where id = v_restroom.business_id;

      if v_business_status is distinct from 'approved' then
        raise exception 'BUSINESS_NOT_APPROVED: partner business must be approved before publishing restroom'
          using errcode = 'HM007';
      end if;
    end if;

    -- 4.5 Active policy check
    select count(*) into v_active_policy_count
    from public.restroom_access_policies
    where restroom_id = p_restroom_id and is_active = true;

    if v_active_policy_count = 0 then
      raise exception 'NO_ACTIVE_POLICY: restroom must have an active access policy' using errcode = 'HM005';
    end if;

    -- 4.6 Update restroom to published
    update public.restrooms
    set
      publication_status = 'published',
      approved_by = v_uid,
      last_verified_at = now()
    where id = p_restroom_id
    returning * into v_restroom;

    v_after_data := to_jsonb(v_restroom);

    -- 4.7 Atomic immutable audit log entry
    insert into public.audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      reason
    ) values (
      v_uid,
      'restroom_published',
      'restrooms',
      p_restroom_id,
      v_before_data,
      v_after_data,
      coalesce(v_review_notes, '관리자 화장실 공개 승인')
    );

  elsif v_decision = 'reject' then
    -- Rejection reason is strictly required (minimum 2 characters after trim)
    if v_reason is null or char_length(v_reason) < 2 then
      raise exception 'REJECTION_REASON_REQUIRED: rejection reason must be at least 2 characters' using errcode = 'HM006';
    end if;

    -- Rejection is only allowed for restrooms currently pending review
    if v_restroom.publication_status = 'published' then
      raise exception 'INVALID_STATUS_TRANSITION: published restroom cannot be rejected; use suspend instead'
        using errcode = 'HM001';
    elsif v_restroom.publication_status <> 'pending' then
      raise exception 'INVALID_STATUS_TRANSITION: only pending restrooms can be rejected'
        using errcode = 'HM001';
    end if;

    -- Transition back to draft and clear approval
    update public.restrooms
    set
      publication_status = 'draft',
      approved_by = null
    where id = p_restroom_id
    returning * into v_restroom;

    v_after_data := to_jsonb(v_restroom);

    -- Atomic immutable audit log entry
    insert into public.audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      reason
    ) values (
      v_uid,
      'restroom_rejected',
      'restrooms',
      p_restroom_id,
      v_before_data,
      v_after_data,
      v_reason
    );

  elsif v_decision = 'suspend' then
    -- Suspension reason is strictly required (minimum 2 characters after trim)
    if v_reason is null or char_length(v_reason) < 2 then
      raise exception 'SUSPENSION_REASON_REQUIRED: suspension reason must be at least 2 characters' using errcode = 'HM006';
    end if;

    -- Duplicate check: already suspended
    if v_restroom.publication_status = 'suspended' then
      raise exception 'ALREADY_SUSPENDED: restroom is already suspended' using errcode = 'HM002';
    end if;

    -- Suspension is strictly allowed only for currently published restrooms
    if v_restroom.publication_status <> 'published' then
      raise exception 'INVALID_STATUS_TRANSITION: only published restrooms can be suspended'
        using errcode = 'HM001';
    end if;

    -- Transition to suspended (removes restroom from public catalog discovery)
    update public.restrooms
    set
      publication_status = 'suspended'
    where id = p_restroom_id
    returning * into v_restroom;

    v_after_data := to_jsonb(v_restroom);

    -- Atomic immutable audit log entry
    insert into public.audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      reason
    ) values (
      v_uid,
      'restroom_suspended',
      'restrooms',
      p_restroom_id,
      v_before_data,
      v_after_data,
      v_reason
    );
  end if;

  return v_restroom;
end;
$$;

revoke all on function public.decide_restroom_review(uuid, text, text, text) from public, anon;
grant execute on function public.decide_restroom_review(uuid, text, text, text) to authenticated, service_role;

-- ============================================================================
-- 2. PHOTO MODERATION RPC WITH ATOMIC AUDIT LOGGING (SECURITY DEFINER)
-- ============================================================================
create or replace function public.moderate_restroom_photo(
  p_photo_id uuid,
  p_moderation_status text,
  p_review_notes text default null
)
returns public.restroom_photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_photo public.restroom_photos;
  v_before_data jsonb;
  v_after_data jsonb;
begin
  -- 1. Authentication & admin check (NULL-safe)
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if not public.is_admin(v_uid) then
    raise exception 'FORBIDDEN_NOT_ADMIN: administrator role required' using errcode = '42501';
  end if;

  -- 2. Validate moderation status parameter (strictly reject NULL and empty strings with 22023)
  if p_moderation_status is null or btrim(p_moderation_status) = '' then
    raise exception 'INVALID_STATUS: moderation_status cannot be null or empty' using errcode = '22023';
  end if;

  v_status := lower(btrim(p_moderation_status));
  if v_status not in ('approved', 'rejected', 'pending') then
    raise exception 'INVALID_STATUS: moderation_status must be approved, rejected, or pending' using errcode = '22023';
  end if;

  -- 3. Lock photo row FOR UPDATE
  select * into v_photo
  from public.restroom_photos
  where id = p_photo_id
  for update;

  if not found then
    raise exception 'PHOTO_NOT_FOUND: photo record does not exist' using errcode = 'P0002';
  end if;

  v_before_data := to_jsonb(v_photo);

  -- 4. Update photo moderation status
  update public.restroom_photos
  set moderation_status = v_status
  where id = p_photo_id
  returning * into v_photo;

  v_after_data := to_jsonb(v_photo);

  -- 5. Atomic immutable audit log entry
  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_uid,
    'photo_' || v_status,
    'restroom_photos',
    p_photo_id,
    v_before_data,
    v_after_data,
    coalesce(nullif(btrim(p_review_notes), ''), '관리자 사진 검수: ' || v_status)
  );

  return v_photo;
end;
$$;

revoke all on function public.moderate_restroom_photo(uuid, text, text) from public, anon;
grant execute on function public.moderate_restroom_photo(uuid, text, text) to authenticated, service_role;
