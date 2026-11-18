-- Migration: 20261107000000_lead_tracking.sql
-- Purpose: TASK 05 Lead tracking schema (business_leads, lead_contact_attempts) and Admin-only RLS
-- Reference: docs/03_DATA_MODEL.md, docs/06_EVENTS_AND_PMF.md, tasks/05_lead_tracking.md

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- 1.1 business_leads — 가게 접촉 대상 50곳(H1 목표치, 상한선 아님)과 H1 모수 관리
-- Note: converted_business_id is created as a UUID column here; FK to businesses(id)
-- will be added in TASK 06 (business_backend) when public.businesses is created.
create table if not exists public.business_leads (
  id uuid primary key default gen_random_uuid(),
  business_name text not null check (char_length(trim(business_name)) > 0),
  category text null,
  road_address text null,
  latitude double precision null check (latitude is null or (latitude >= -90 and latitude <= 90)),
  longitude double precision null check (longitude is null or (longitude >= -180 and longitude <= 180)),
  contact_phone text null,
  lead_source text null,
  assigned_user_id uuid null references public.profiles(id) on delete set null,
  converted_business_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_business_leads_coords_pair check (
    (latitude is null and longitude is null)
    or (latitude is not null and longitude is not null)
  )
);

drop trigger if exists set_business_leads_updated_at on public.business_leads;
create trigger set_business_leads_updated_at
  before update on public.business_leads
  for each row
  execute function public.handle_updated_at();

create index if not exists idx_business_leads_assigned_user_id
  on public.business_leads(assigned_user_id);

-- Partial unique index: allows multiple NULLs before conversion, while ensuring
-- a single registered business cannot be linked to multiple leads to inflate H1 counts.
create unique index if not exists idx_business_leads_converted_business_id
  on public.business_leads(converted_business_id)
  where converted_business_id is not null;

create index if not exists idx_business_leads_created_at
  on public.business_leads(created_at desc);

-- 1.2 lead_contact_attempts — 연락 실적 (시도와 실등록은 별개)
create table if not exists public.lead_contact_attempts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.business_leads(id) on delete cascade,
  contacted_by uuid not null references public.profiles(id) on delete restrict,
  contacted_at timestamptz not null default now(),
  channel text not null check (channel in ('visit', 'phone', 'message', 'email')),
  result text not null check (result in ('no_answer', 'rejected', 'interested', 'agreed', 'follow_up')),
  notes text null,
  next_contact_at timestamptz null
);

create index if not exists idx_lead_contact_attempts_lead_id_contacted_at
  on public.lead_contact_attempts(lead_id, contacted_at desc);

create index if not exists idx_lead_contact_attempts_contacted_by
  on public.lead_contact_attempts(contacted_by);

create index if not exists idx_lead_contact_attempts_result
  on public.lead_contact_attempts(result);

-- ============================================================================
-- 2. ROW LEVEL SECURITY (RLS) & PRIVILEGES — STRICTLY ADMIN ONLY
-- ============================================================================

alter table public.business_leads enable row level security;
alter table public.lead_contact_attempts enable row level security;

-- Default deny for PUBLIC, anon, and non-admin authenticated users
revoke all on public.business_leads from public, anon, authenticated;
revoke all on public.lead_contact_attempts from public, anon, authenticated;

-- Grant table-level DML to authenticated (filtered by admin-only RLS) and service_role
grant select, insert, update on public.business_leads to authenticated, service_role;
grant select, insert on public.lead_contact_attempts to authenticated, service_role;

-- 2.1 business_leads policies (admin only; contact_phone is private)
drop policy if exists "business_leads_select_admin" on public.business_leads;
create policy "business_leads_select_admin"
  on public.business_leads
  for select
  to authenticated
  using (public.is_admin(auth.uid()));

drop policy if exists "business_leads_insert_admin" on public.business_leads;
create policy "business_leads_insert_admin"
  on public.business_leads
  for insert
  to authenticated
  with check (public.is_admin(auth.uid()));

drop policy if exists "business_leads_update_admin" on public.business_leads;
create policy "business_leads_update_admin"
  on public.business_leads
  for update
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- 2.2 lead_contact_attempts policies (admin only; notes is private)
drop policy if exists "lead_contact_attempts_select_admin" on public.lead_contact_attempts;
create policy "lead_contact_attempts_select_admin"
  on public.lead_contact_attempts
  for select
  to authenticated
  using (public.is_admin(auth.uid()));

drop policy if exists "lead_contact_attempts_insert_admin" on public.lead_contact_attempts;
create policy "lead_contact_attempts_insert_admin"
  on public.lead_contact_attempts
  for insert
  to authenticated
  with check (
    public.is_admin(auth.uid())
    and contacted_by = auth.uid()
  );

-- Note: Per AGENTS.md Rule 17 and tasks/05_lead_tracking.md, no fake real-world business leads are seeded.
