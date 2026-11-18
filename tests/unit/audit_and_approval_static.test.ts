import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/20261109000000_audit_and_approval.sql"
);

const rawSql = readFileSync(MIGRATION_PATH, "utf8");
const sql = rawSql
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

describe("TASK 08: Migration 20261109000000_audit_and_approval Static Security Checks", () => {
  it("creates audit_logs table with required columns from docs/03_DATA_MODEL.md", () => {
    expect(sql).toContain("create table if not exists public.audit_logs");
    expect(sql).toContain("actor_user_id uuid");
    expect(sql).toContain("action text not null");
    expect(sql).toContain("entity_type text not null");
    expect(sql).toContain("entity_id uuid not null");
    expect(sql).toContain("before_data jsonb");
    expect(sql).toContain("after_data jsonb");
    expect(sql).toContain("reason text");
    expect(sql).toContain("created_at timestamptz");
  });

  it("enforces immutable audit log via trigger blocking update and delete", () => {
    expect(sql).toContain("create trigger trg_prevent_audit_logs_mutation");
    expect(sql).toContain("before update or delete on public.audit_logs");
    expect(sql).toContain("prevent_audit_logs_mutation()");
  });

  it("enables RLS on audit_logs and restricts access to admin/service_role", () => {
    expect(sql).toContain("alter table public.audit_logs enable row level security");
    expect(sql).toContain("revoke all on public.audit_logs from public, anon, authenticated");
    expect(sql).toContain("grant select on public.audit_logs to authenticated");
    expect(sql).toContain("grant select, insert on public.audit_logs to service_role");
    expect(sql).toContain("public.is_admin(auth.uid())");
    expect(sql).not.toMatch(/grant\s+update.*on\s+public\.audit_logs/);
    expect(sql).not.toMatch(/grant\s+delete.*on\s+public\.audit_logs/);
  });

  it("defines atomic decide_business_approval RPC as SECURITY DEFINER with admin check", () => {
    expect(sql).toContain("create or replace function public.decide_business_approval");
    expect(sql).toContain("security definer");
    expect(sql).toContain("public.is_admin(v_uid)");
    expect(sql).toContain("p_decision is null or btrim(p_decision) = ''");
    expect(sql).toContain("rejection_reason_required");
    expect(sql).toContain("verification_required_for_approval");
  });

  it("enforces ON DELETE RESTRICT on actor_user_id and strictly blocks all mutations on audit_logs", () => {
    expect(sql).toContain("actor_user_id uuid null references public.profiles(id) on delete restrict");
    expect(sql).toContain("raise exception 'immutable audit log: update and delete operations are prohibited'");
  });

  it("atomically grants merchant role in user_roles upon approval", () => {
    expect(sql).toContain("insert into public.user_roles");
    expect(sql).toContain("'merchant'");
    expect(sql).toContain("on conflict (user_id, role) do nothing");
  });

  it("writes immutable audit log entry for both approval and rejection", () => {
    expect(sql).toContain("insert into public.audit_logs");
    expect(sql).toContain("'business.approve'");
    expect(sql).toContain("'business.reject'");
  });
});

