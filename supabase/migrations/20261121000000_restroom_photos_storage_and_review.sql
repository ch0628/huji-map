-- Migration: 20261121000000_restroom_photos_storage_and_review.sql
-- Purpose: STEP 3 Restroom Photos (Private Storage bucket, slot/replacement rules,
--          integrated publish approval, and atomic post-approval photo replacement)
-- Reference: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md

-- ============================================================================
-- 1. EXTEND public.restroom_photos FOR SAFE REPLACEMENT TRACKING
-- ============================================================================
alter table public.restroom_photos
  add column if not exists replaces_photo_id uuid null references public.restroom_photos(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_restroom_photos_no_self_replace'
      and conrelid = 'public.restroom_photos'::regclass
  ) then
    alter table public.restroom_photos
      add constraint chk_restroom_photos_no_self_replace
      check (replaces_photo_id is null or replaces_photo_id <> id);
  end if;
end $$;

-- At most one pending replacement per approved target photo
create unique index if not exists idx_restroom_photos_single_pending_replacement
  on public.restroom_photos(replaces_photo_id)
  where replaces_photo_id is not null and moderation_status = 'pending';

create index if not exists idx_restroom_photos_restroom_status
  on public.restroom_photos(restroom_id, moderation_status);

-- ============================================================================
-- 2. PRIVATE STORAGE BUCKET & RLS POLICIES (storage schema if present)
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'restroom-photos',
      'restroom-photos',
      false,
      10485760,
      array['image/jpeg', 'image/png', 'image/webp']
    )
    on conflict (id) do update set
      public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

    -- Select: admin or active business member of the owning partner restroom
    drop policy if exists "restroom_photos_storage_select_member_or_admin" on storage.objects;
    create policy "restroom_photos_storage_select_member_or_admin"
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'restroom-photos'
        and (
          public.is_admin(auth.uid())
          or (
            (storage.foldername(name))[1] = 'restrooms'
            and (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            and public.is_restroom_business_member(((storage.foldername(name))[2])::uuid)
          )
        )
      );

    -- Direct authenticated INSERT/DELETE blocked; uploads/deletes go via server signed URLs & verified APIs
    drop policy if exists "restroom_photos_storage_insert_admin_only" on storage.objects;
    create policy "restroom_photos_storage_insert_admin_only"
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'restroom-photos'
        and public.is_admin(auth.uid())
      );

    drop policy if exists "restroom_photos_storage_delete_admin_only" on storage.objects;
    create policy "restroom_photos_storage_delete_admin_only"
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'restroom-photos'
        and public.is_admin(auth.uid())
      );
  end if;
end $$;

-- ============================================================================
-- 3. ATOMIC MERCHANT PHOTO REGISTRATION & DELETION RPCs (service_role only)
-- ============================================================================

create or replace function public.register_merchant_restroom_photo(
  p_restroom_id uuid,
  p_caller_user_id uuid,
  p_storage_path text,
  p_photo_type text default 'other',
  p_is_primary boolean default false,
  p_replaces_photo_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_restroom public.restrooms;
  v_business_status text;
  v_is_admin boolean := false;
  v_is_member boolean := false;
  v_photo_type text;
  v_expected_prefix text;
  v_approved_count integer := 0;
  v_pending_new_count integer := 0;
  v_has_approved_primary boolean := false;
  v_target_photo public.restroom_photos;
  v_existing_replacement_count integer := 0;
  v_effective_is_primary boolean := coalesce(p_is_primary, false);
  v_inserted public.restroom_photos;
begin
  if p_caller_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'status', 401,
      'error_code', 'UNAUTHORIZED',
      'message', '로그인이 필요합니다.'
    );
  end if;

  if p_restroom_id is null or coalesce(btrim(p_storage_path), '') = '' then
    return jsonb_build_object(
      'ok', false,
      'status', 400,
      'error_code', 'VALIDATION_ERROR',
      'message', '화장실 ID와 저장 경로가 필요합니다.'
    );
  end if;

  v_photo_type := lower(btrim(coalesce(p_photo_type, 'other')));
  if v_photo_type not in ('exterior', 'entrance', 'interior', 'signage', 'other') then
    return jsonb_build_object(
      'ok', false,
      'status', 400,
      'error_code', 'VALIDATION_ERROR',
      'message', '지원하지 않는 사진 유형입니다.'
    );
  end if;

  v_expected_prefix := 'restrooms/' || p_restroom_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    return jsonb_build_object(
      'ok', false,
      'status', 403,
      'error_code', 'FORBIDDEN',
      'message', '유효하지 않은 저장 경로입니다.'
    );
  end if;

  -- Lock restroom row to serialize slot checks & primary-flag updates
  select * into v_restroom
  from public.restrooms
  where id = p_restroom_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'status', 404,
      'error_code', 'RESTROOM_NOT_FOUND',
      'message', '화장실을 찾을 수 없습니다.'
    );
  end if;

  if v_restroom.type <> 'partner' or v_restroom.business_id is null then
    return jsonb_build_object(
      'ok', false,
      'status', 403,
      'error_code', 'FORBIDDEN_PUBLIC_RESTROOM',
      'message', '제휴 화장실에만 사진을 등록할 수 있습니다.'
    );
  end if;

  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = p_caller_user_id
      and ur.role = 'admin'
  ) into v_is_admin;

  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = v_restroom.business_id
      and bm.user_id = p_caller_user_id
      and bm.membership_status = 'active'
  ) into v_is_member;

  if not v_is_admin and not v_is_member then
    return jsonb_build_object(
      'ok', false,
      'status', 403,
      'error_code', 'FORBIDDEN',
      'message', '본인 가게의 화장실 사진만 등록할 수 있습니다.'
    );
  end if;

  select b.registration_status into v_business_status
  from public.businesses b
  where b.id = v_restroom.business_id;

  if not v_is_admin and v_business_status is distinct from 'approved' then
    return jsonb_build_object(
      'ok', false,
      'status', 403,
      'error_code', 'BUSINESS_NOT_APPROVED',
      'message', '승인된 가게의 화장실만 사진을 등록할 수 있습니다.'
    );
  end if;

  select count(*)::int into v_approved_count
  from public.restroom_photos rp
  where rp.restroom_id = p_restroom_id
    and rp.moderation_status = 'approved';

  select count(*)::int into v_pending_new_count
  from public.restroom_photos rp
  where rp.restroom_id = p_restroom_id
    and rp.moderation_status = 'pending'
    and rp.replaces_photo_id is null;

  -- Case A: Replacement upload for an existing approved photo
  if p_replaces_photo_id is not null then
    select * into v_target_photo
    from public.restroom_photos rp
    where rp.id = p_replaces_photo_id
      and rp.restroom_id = p_restroom_id
    for update;

    if not found then
      return jsonb_build_object(
        'ok', false,
        'status', 404,
        'error_code', 'TARGET_PHOTO_NOT_FOUND',
        'message', '교체 대상 사진을 찾을 수 없습니다.'
      );
    end if;

    if v_target_photo.moderation_status <> 'approved' then
      return jsonb_build_object(
        'ok', false,
        'status', 422,
        'error_code', 'INVALID_REPLACEMENT_TARGET',
        'message', '승인된 사진만 교체 요청할 수 있습니다.'
      );
    end if;

    select count(*)::int into v_existing_replacement_count
    from public.restroom_photos rp
    where rp.replaces_photo_id = p_replaces_photo_id
      and rp.moderation_status = 'pending';

    if v_existing_replacement_count > 0 then
      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'error_code', 'PENDING_REPLACEMENT_EXISTS',
        'message', '이미 해당 사진에 대한 교체 심사가 대기 중입니다. 기존 대기 사진을 삭제한 후 다시 시도해 주세요.'
      );
    end if;

    -- Keep existing approved photo live & is_primary intact until admin approves replacement
    insert into public.restroom_photos (
      restroom_id,
      storage_path,
      photo_type,
      is_primary,
      moderation_status,
      uploaded_by,
      replaces_photo_id
    ) values (
      p_restroom_id,
      p_storage_path,
      v_photo_type,
      false,
      'pending',
      p_caller_user_id,
      p_replaces_photo_id
    )
    returning * into v_inserted;

    return jsonb_build_object(
      'ok', true,
      'photo', to_jsonb(v_inserted)
    );
  end if;

  -- Case B: Normal new photo upload (max 3 slots across approved + pending non-replacement)
  if (v_approved_count + v_pending_new_count) >= 3 then
    return jsonb_build_object(
      'ok', false,
      'status', 422,
      'error_code', 'PHOTO_LIMIT_EXCEEDED',
      'message', '화장실당 최대 3장까지 등록할 수 있습니다. 승인된 사진을 바꾸려면 사진 교체를 이용해 주세요.'
    );
  end if;

  select exists (
    select 1
    from public.restroom_photos rp
    where rp.restroom_id = p_restroom_id
      and rp.is_primary = true
      and rp.moderation_status = 'approved'
  ) into v_has_approved_primary;

  if v_effective_is_primary then
    if v_has_approved_primary then
      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'error_code', 'PRIMARY_REPLACEMENT_REQUIRED',
        'message', '이미 승인된 대표 사진이 있습니다. 대표 사진 변경은 기존 대표 사진의 교체 기능을 이용해 주세요.'
      );
    end if;

    -- Unset any unapproved pending primary flag on this restroom before assigning new primary
    update public.restroom_photos
    set is_primary = false
    where restroom_id = p_restroom_id
      and is_primary = true
      and moderation_status = 'pending';
  elsif (v_approved_count + v_pending_new_count) = 0 then
    -- First uploaded photo automatically becomes primary if none exists
    v_effective_is_primary := true;
  end if;

  insert into public.restroom_photos (
    restroom_id,
    storage_path,
    photo_type,
    is_primary,
    moderation_status,
    uploaded_by,
    replaces_photo_id
  ) values (
    p_restroom_id,
    p_storage_path,
    v_photo_type,
    v_effective_is_primary,
    'pending',
    p_caller_user_id,
    null
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'ok', true,
    'photo', to_jsonb(v_inserted)
  );
end;
$$;

revoke all on function public.register_merchant_restroom_photo(uuid, uuid, text, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.register_merchant_restroom_photo(uuid, uuid, text, text, boolean, uuid) to service_role;

create or replace function public.delete_merchant_restroom_photo(
  p_restroom_id uuid,
  p_photo_id uuid,
  p_caller_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_restroom public.restrooms;
  v_is_admin boolean := false;
  v_is_member boolean := false;
  v_photo public.restroom_photos;
begin
  if p_caller_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'status', 401,
      'error_code', 'UNAUTHORIZED',
      'message', '로그인이 필요합니다.'
    );
  end if;

  select * into v_restroom
  from public.restrooms
  where id = p_restroom_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'status', 404,
      'error_code', 'RESTROOM_NOT_FOUND',
      'message', '화장실을 찾을 수 없습니다.'
    );
  end if;

  if v_restroom.type <> 'partner' or v_restroom.business_id is null then
    return jsonb_build_object(
      'ok', false,
      'status', 403,
      'error_code', 'FORBIDDEN_PUBLIC_RESTROOM',
      'message', '제휴 화장실 사진만 삭제할 수 있습니다.'
    );
  end if;

  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = p_caller_user_id and ur.role = 'admin'
  ) into v_is_admin;

  select exists (
    select 1 from public.business_members bm
    where bm.business_id = v_restroom.business_id
      and bm.user_id = p_caller_user_id
      and bm.membership_status = 'active'
  ) into v_is_member;

  if not v_is_admin and not v_is_member then
    return jsonb_build_object(
      'ok', false,
      'status', 403,
      'error_code', 'FORBIDDEN',
      'message', '타인 가게 화장실의 사진을 삭제할 수 없습니다.'
    );
  end if;

  select * into v_photo
  from public.restroom_photos rp
  where rp.id = p_photo_id
    and rp.restroom_id = p_restroom_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'status', 404,
      'error_code', 'PHOTO_NOT_FOUND',
      'message', '사진을 찾을 수 없습니다.'
    );
  end if;

  if not v_is_admin and v_photo.moderation_status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'status', 403,
      'error_code', 'FORBIDDEN_APPROVED_PHOTO',
      'message', '이미 승인되었거나 검수 완료된 사진은 삭제할 수 없습니다. 사진 교체를 이용해 주세요.'
    );
  end if;

  delete from public.restroom_photos
  where id = p_photo_id;

  -- If deleted pending photo was primary and other pending non-replacement photo exists without approved primary, promote first pending one
  if v_photo.is_primary then
    update public.restroom_photos
    set is_primary = true
    where id = (
      select rp.id
      from public.restroom_photos rp
      where rp.restroom_id = p_restroom_id
        and rp.moderation_status = 'pending'
        and rp.replaces_photo_id is null
      order by rp.created_at asc
      limit 1
    )
    and not exists (
      select 1
      from public.restroom_photos rp2
      where rp2.restroom_id = p_restroom_id
        and rp2.is_primary = true
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'deleted', to_jsonb(v_photo)
  );
end;
$$;

revoke all on function public.delete_merchant_restroom_photo(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_merchant_restroom_photo(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 4. INTEGRATED RESTROOM + PENDING PHOTOS APPROVAL RPC (decide_restroom_review)
-- ============================================================================
create or replace function public.decide_restroom_review(
  p_restroom_id uuid,
  p_decision text,
  p_reason text default null,
  p_review_notes text default null
)
returns public.restrooms
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
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
  v_rep_rec record;
  v_old_photo public.restroom_photos;
  v_old_was_primary boolean;
  v_new_photo public.restroom_photos;
  v_photo_rec public.restroom_photos;
begin
  -- 1. Authentication & admin check (NULL-safe)
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if not public.is_admin(v_uid) then
    raise exception 'FORBIDDEN_NOT_ADMIN: administrator role required' using errcode = '42501';
  end if;

  -- 2. Validate decision parameter
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

  -- 4. Process decision
  if v_decision = 'publish' then
    if v_restroom.publication_status = 'published' then
      raise exception 'ALREADY_PUBLISHED: restroom is already published' using errcode = 'HM002';
    end if;

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

    if coalesce(trim(v_restroom.name), '') = '' or coalesce(trim(v_restroom.road_address), '') = '' then
      raise exception 'INCOMPLETE_RESTROOM: name and road_address are required' using errcode = 'HM005';
    end if;

    if v_restroom.latitude is null or v_restroom.longitude is null then
      raise exception 'INCOMPLETE_RESTROOM: latitude and longitude are required' using errcode = 'HM005';
    end if;

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

    -- 4.7 Atomically apply any pending photo replacements first, then approve pending new photos
    for v_rep_rec in
      select *
      from public.restroom_photos
      where restroom_id = p_restroom_id
        and moderation_status = 'pending'
        and replaces_photo_id is not null
      order by created_at asc
      for update
    loop
      select * into v_old_photo
      from public.restroom_photos
      where id = v_rep_rec.replaces_photo_id
        and restroom_id = p_restroom_id
      for update;

      v_old_was_primary := coalesce(v_old_photo.is_primary, false);

      if found then
        update public.restroom_photos
        set is_primary = false,
            moderation_status = 'rejected'
        where id = v_old_photo.id;
      end if;

      update public.restroom_photos
      set is_primary = v_old_was_primary,
          moderation_status = 'approved',
          replaces_photo_id = null
      where id = v_rep_rec.id
      returning * into v_new_photo;

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
        'photo_replacement_approved',
        'restroom_photos',
        v_new_photo.id,
        to_jsonb(v_rep_rec),
        to_jsonb(v_new_photo),
        coalesce(v_review_notes, '화장실 공개 승인과 함께 교체 사진 일괄 승인')
      );
    end loop;

    for v_photo_rec in
      select *
      from public.restroom_photos
      where restroom_id = p_restroom_id
        and moderation_status = 'pending'
        and replaces_photo_id is null
      order by is_primary desc, created_at asc
      for update
    loop
      update public.restroom_photos
      set moderation_status = 'approved'
      where id = v_photo_rec.id
      returning * into v_new_photo;

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
        'photo_approved',
        'restroom_photos',
        v_new_photo.id,
        to_jsonb(v_photo_rec),
        to_jsonb(v_new_photo),
        coalesce(v_review_notes, '화장실 공개 승인과 함께 첨부 사진 일괄 승인')
      );
    end loop;

    -- Ensure an approved photo is marked primary if none is primary yet
    if not exists (
      select 1
      from public.restroom_photos
      where restroom_id = p_restroom_id
        and is_primary = true
    ) then
      update public.restroom_photos
      set is_primary = true
      where id = (
        select rp.id
        from public.restroom_photos rp
        where rp.restroom_id = p_restroom_id
          and rp.moderation_status = 'approved'
        order by rp.created_at asc
        limit 1
      );
    end if;

  elsif v_decision = 'reject' then
    if v_reason is null or char_length(v_reason) < 2 then
      raise exception 'REJECTION_REASON_REQUIRED: rejection reason must be at least 2 characters' using errcode = 'HM006';
    end if;

    if v_restroom.publication_status = 'published' then
      raise exception 'INVALID_STATUS_TRANSITION: published restroom cannot be rejected; use suspend instead'
        using errcode = 'HM001';
    elsif v_restroom.publication_status <> 'pending' then
      raise exception 'INVALID_STATUS_TRANSITION: only pending restrooms can be rejected'
        using errcode = 'HM001';
    end if;

    update public.restrooms
    set
      publication_status = 'draft',
      approved_by = null
    where id = p_restroom_id
    returning * into v_restroom;

    v_after_data := to_jsonb(v_restroom);

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
    if v_reason is null or char_length(v_reason) < 2 then
      raise exception 'SUSPENSION_REASON_REQUIRED: suspension reason must be at least 2 characters' using errcode = 'HM006';
    end if;

    if v_restroom.publication_status = 'suspended' then
      raise exception 'ALREADY_SUSPENDED: restroom is already suspended' using errcode = 'HM002';
    end if;

    if v_restroom.publication_status <> 'published' then
      raise exception 'INVALID_STATUS_TRANSITION: only published restrooms can be suspended'
        using errcode = 'HM001';
    end if;

    update public.restrooms
    set publication_status = 'suspended'
    where id = p_restroom_id
    returning * into v_restroom;

    v_after_data := to_jsonb(v_restroom);

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
-- 5. ATOMIC POST-APPROVAL PHOTO REPLACEMENT / PENDING PHOTO DECISION RPC
-- ============================================================================
create or replace function public.decide_restroom_photo_replacement(
  p_photo_id uuid,
  p_decision text,
  p_reason text default null
)
returns public.restroom_photos
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_decision text;
  v_reason text := nullif(btrim(p_reason), '');
  v_new_photo public.restroom_photos;
  v_old_photo public.restroom_photos;
  v_restroom public.restrooms;
  v_before_new jsonb;
  v_after_new jsonb;
  v_before_old jsonb;
  v_after_old jsonb;
  v_old_was_primary boolean := false;
  v_approved_count integer := 0;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if not public.is_admin(v_uid) then
    raise exception 'FORBIDDEN_NOT_ADMIN: administrator role required' using errcode = '42501';
  end if;

  if p_decision is null or btrim(p_decision) = '' then
    raise exception 'INVALID_DECISION: decision cannot be null or empty' using errcode = '22023';
  end if;

  v_decision := lower(btrim(p_decision));
  if v_decision not in ('approve', 'reject') then
    raise exception 'INVALID_DECISION: decision must be approve or reject' using errcode = '22023';
  end if;

  -- Lock target pending photo first to find restroom_id, then lock restroom row to serialize swaps
  select * into v_new_photo
  from public.restroom_photos
  where id = p_photo_id
  for update;

  if not found then
    raise exception 'PHOTO_NOT_FOUND: photo record does not exist' using errcode = 'P0002';
  end if;

  select * into v_restroom
  from public.restrooms
  where id = v_new_photo.restroom_id
  for update;

  if v_new_photo.moderation_status <> 'pending' then
    raise exception 'ALREADY_MODERATED: only pending photos can be reviewed' using errcode = 'HM002';
  end if;

  v_before_new := to_jsonb(v_new_photo);

  if v_decision = 'approve' then
    if v_new_photo.replaces_photo_id is not null then
      select * into v_old_photo
      from public.restroom_photos
      where id = v_new_photo.replaces_photo_id
        and restroom_id = v_new_photo.restroom_id
      for update;

      if not found then
        raise exception 'TARGET_PHOTO_NOT_FOUND: replacement target photo does not exist' using errcode = 'P0002';
      end if;

      v_before_old := to_jsonb(v_old_photo);
      v_old_was_primary := v_old_photo.is_primary;

      -- Step 1: Demote & retire old approved photo first to satisfy idx_restroom_photos_single_primary
      update public.restroom_photos
      set is_primary = false,
          moderation_status = 'rejected'
      where id = v_old_photo.id
      returning * into v_old_photo;

      v_after_old := to_jsonb(v_old_photo);

      -- Step 2: Promote new photo to approved (inheriting primary flag if old photo was primary)
      update public.restroom_photos
      set is_primary = v_old_was_primary,
          moderation_status = 'approved',
          replaces_photo_id = null
      where id = v_new_photo.id
      returning * into v_new_photo;

      v_after_new := to_jsonb(v_new_photo);

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
        'photo_replaced_out',
        'restroom_photos',
        v_old_photo.id,
        v_before_old,
        v_after_old,
        coalesce(v_reason, '새 사진 승인으로 기존 사진 교체')
      );

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
        'photo_replacement_approved',
        'restroom_photos',
        v_new_photo.id,
        v_before_new,
        v_after_new,
        coalesce(v_reason, '관리자 교체 사진 승인')
      );
    else
      select count(*)::int into v_approved_count
      from public.restroom_photos
      where restroom_id = v_new_photo.restroom_id
        and moderation_status = 'approved';

      if v_approved_count >= 3 then
        raise exception 'PHOTO_LIMIT_EXCEEDED: restroom already has 3 approved photos' using errcode = 'HM005';
      end if;

      update public.restroom_photos
      set moderation_status = 'approved'
      where id = v_new_photo.id
      returning * into v_new_photo;

      v_after_new := to_jsonb(v_new_photo);

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
        'photo_approved',
        'restroom_photos',
        v_new_photo.id,
        v_before_new,
        v_after_new,
        coalesce(v_reason, '관리자 추가 사진 승인')
      );
    end if;

  elsif v_decision = 'reject' then
    if v_reason is null or char_length(v_reason) < 2 then
      raise exception 'REJECTION_REASON_REQUIRED: rejection reason must be at least 2 characters' using errcode = 'HM006';
    end if;

    -- Reject new pending photo only; existing approved photo remains completely untouched
    update public.restroom_photos
    set is_primary = false,
        moderation_status = 'rejected'
    where id = v_new_photo.id
    returning * into v_new_photo;

    v_after_new := to_jsonb(v_new_photo);

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
      'photo_rejected',
      'restroom_photos',
      v_new_photo.id,
      v_before_new,
      v_after_new,
      v_reason
    );
  end if;

  return v_new_photo;
end;
$$;

revoke all on function public.decide_restroom_photo_replacement(uuid, text, text) from public, anon;
grant execute on function public.decide_restroom_photo_replacement(uuid, text, text) to authenticated, service_role;
