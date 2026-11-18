-- Migration: 20261109000000_audit_and_approval.sql
-- Purpose: TASK 08 Administrator business verification, approval, rejection, and audit log schema
-- Reference: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md, tasks/08_business_approval.md

-- ============================================================================
-- 1. AUDIT LOGS TABLE (docs/03_DATA_MODEL.md line 415)
-- ============================================================================
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid null references public.profiles(id) on delete restrict,
  action text not null check (char_length(trim(action)) > 0 and char_length(action) <= 100),
  entity_type text not null check (char_length(trim(entity_type)) > 0 and char_length(entity_type) <= 50),
  entity_id uuid not null,
  before_data jsonb null,
  after_data jsonb null,
  reason text null check (reason is null or char_length(reason) <= 1000),
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_entity
  on public.audit_logs(entity_type, entity_id);

create index if not exists idx_audit_logs_actor
  on public.audit_logs(actor_user_id);

create index if not exists idx_audit_logs_created_at
  on public.audit_logs(created_at desc);

-- Defense in depth: Immutable audit log (docs/08_SECURITY_OPERATIONS.md line 10)
-- Audit logs are strictly append-only. All UPDATE and DELETE operations are prohibited.
-- Referenced user profiles are protected from deletion via ON DELETE RESTRICT on actor_user_id.
create or replace function public.prevent_audit_logs_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Immutable audit log: UPDATE and DELETE operations are prohibited'
    using errcode = '42501';
end;
$$;

drop trigger if exists trg_prevent_audit_logs_mutation on public.audit_logs;
create trigger trg_prevent_audit_logs_mutation
  before update or delete on public.audit_logs
  for each row
  execute function public.prevent_audit_logs_mutation();

-- RLS on audit_logs
alter table public.audit_logs enable row level security;

revoke all on public.audit_logs from public, anon, authenticated;
grant select on public.audit_logs to authenticated;
grant select, insert on public.audit_logs to service_role;

create policy "audit_logs_select_admin_only"
  on public.audit_logs
  for select
  to authenticated
  using (public.is_admin(auth.uid()));

-- ============================================================================
-- 2. ATOMIC BUSINESS APPROVAL / REJECTION RPC (SECURITY DEFINER)
-- ============================================================================
-- Atomically transitions a pending business to approved or rejected.
-- If approved:
--   - Validates that a pending verification record exists (rejects if none exists)
--   - Updates businesses.registration_status = 'approved', approved_by, approved_at
--   - Updates business_verifications status = 'approved', reviewed_by, reviewed_at
--   - Atomically grants 'merchant' role to business owner in user_roles
--   - Writes append-only audit_logs entry
-- If rejected:
--   - Requires non-empty rejection reason
--   - Updates businesses.registration_status = 'rejected', rejection_reason
--   - If pending verifications exist, updates status = 'rejected' (does not fabricate fake records)
--   - Writes append-only audit_logs entry
--   - Does NOT revoke pre-existing merchant role if owner has other approved businesses
create or replace function public.decide_business_approval(
  p_business_id uuid,
  p_decision text,
  p_rejection_reason text default null,
  p_review_notes text default null
)
returns public.businesses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_decision text;
  v_rejection_reason text := nullif(btrim(p_rejection_reason), '');
  v_review_notes text := nullif(btrim(p_review_notes), '');
  v_business public.businesses;
  v_owner_id uuid;
begin
  -- 1. Authentication & admin role verification (NULL-safe)
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if coalesce(public.is_admin(v_uid), false) is not true then
    raise exception 'FORBIDDEN_ADMIN_ONLY' using errcode = '42501';
  end if;

  -- 2. Validate decision argument (Explicit NULL, empty string, and whitelist check)
  if p_decision is null or btrim(p_decision) = '' then
    raise exception 'INVALID_DECISION' using errcode = 'HM005';
  end if;

  v_decision := lower(btrim(p_decision));
  if v_decision not in ('approved', 'rejected') then
    raise exception 'INVALID_DECISION' using errcode = 'HM005';
  end if;

  if v_decision = 'rejected' and v_rejection_reason is null then
    raise exception 'REJECTION_REASON_REQUIRED' using errcode = 'HM005';
  end if;

  -- 3. Lock business row
  select * into v_business
  from public.businesses
  where id = p_business_id
  for update;

  if not found then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 4. Status conflict checks
  if v_business.registration_status = 'approved' then
    raise exception 'BUSINESS_ALREADY_APPROVED' using errcode = 'HM002';
  elsif v_business.registration_status = 'rejected' and v_decision = 'rejected' then
    raise exception 'BUSINESS_ALREADY_REJECTED' using errcode = 'HM006';
  elsif v_business.registration_status = 'suspended' then
    raise exception 'BUSINESS_SUSPENDED' using errcode = 'HM003';
  elsif v_business.registration_status <> 'pending' then
    raise exception 'BUSINESS_NOT_PENDING' using errcode = 'HM005';
  end if;

  v_owner_id := v_business.created_by;

  -- 5. Execute decision
  if v_decision = 'approved' then
    -- A pending verification record is strictly required before approval
    -- (No automated fabrication of unverified in_person or phone records)
    if not exists (
      select 1 from public.business_verifications
      where business_id = p_business_id and status = 'pending'
    ) then
      raise exception 'VERIFICATION_REQUIRED_FOR_APPROVAL' using errcode = 'HM005';
    end if;

    update public.businesses
    set registration_status = 'approved',
        approved_by = v_uid,
        approved_at = now(),
        rejection_reason = null,
        updated_at = now()
    where id = p_business_id
    returning * into v_business;

    -- Synchronize pending verification to approved
    update public.business_verifications
    set status = 'approved',
        reviewed_by = v_uid,
        reviewed_at = now(),
        review_notes = v_review_notes
    where business_id = p_business_id
      and status = 'pending';

    -- Atomically grant merchant role to owner
    insert into public.user_roles (user_id, role, granted_by, created_at)
    values (v_owner_id, 'merchant', v_uid, now())
    on conflict (user_id, role) do nothing;

    -- Record immutable audit log
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
      'business.approve',
      'businesses',
      p_business_id,
      jsonb_build_object('registration_status', 'pending'),
      jsonb_build_object(
        'registration_status', 'approved',
        'approved_by', v_uid,
        'approved_at', v_business.approved_at,
        'granted_merchant_to', v_owner_id
      ),
      v_review_notes
    );

  else -- rejected
    update public.businesses
    set registration_status = 'rejected',
        approved_by = null,
        approved_at = null,
        rejection_reason = v_rejection_reason,
        updated_at = now()
    where id = p_business_id
    returning * into v_business;

    -- Synchronize pending verifications to rejected if any exist; do NOT fabricate fake records if none exist
    update public.business_verifications
    set status = 'rejected',
        reviewed_by = v_uid,
        reviewed_at = now(),
        review_notes = coalesce(v_review_notes, v_rejection_reason)
    where business_id = p_business_id
      and status = 'pending';

    -- Record immutable audit log
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
      'business.reject',
      'businesses',
      p_business_id,
      jsonb_build_object('registration_status', 'pending'),
      jsonb_build_object(
        'registration_status', 'rejected',
        'rejection_reason', v_rejection_reason
      ),
      v_rejection_reason
    );
  end if;

  return v_business;
end;
$$;

revoke all on function public.decide_business_approval(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_business_approval(uuid, text, text, text) to authenticated, service_role;
