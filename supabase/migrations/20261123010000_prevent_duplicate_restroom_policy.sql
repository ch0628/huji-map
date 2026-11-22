-- Migration: 20261123010000_prevent_duplicate_restroom_policy.sql
-- Purpose: TASK-04 — Prevent duplicate active policy versions on server RPC when
--          all effective policy conditions match the currently active policy.
--
-- Note: Local migration only (remote DB application awaits user approval).

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
  v_active_policy public.restroom_access_policies;
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

  -- Lock restroom row to serialize concurrent policy updates
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

  -- Compare effective conditions against current active policy
  select * into v_active_policy
  from public.restroom_access_policies
  where restroom_id = p_restroom_id
    and is_active = true
  order by version desc
  limit 1;

  if v_active_policy.id is not null
     and v_active_policy.access_mode = p_access_mode
     and v_active_policy.deposit_amount_krw = v_actual_deposit
     and v_active_policy.refund_eligible = v_actual_refund
     and v_active_policy.receipt_window_hours is not distinct from v_actual_receipt_window
     and v_active_policy.min_purchase_krw = v_actual_min_purchase then
    raise exception 'POLICY_UNCHANGED: active policy already has identical conditions'
      using errcode = 'HM002';
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
