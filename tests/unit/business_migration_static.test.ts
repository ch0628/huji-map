import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TASK 06-A static security checks for the UNAPPLIED migration 20261108000000_business_backend.sql.
 * No database is available locally, so these tests parse the SQL text. They guard GRANT/RLS/definer
 * invariants and are NOT a substitute for the live rollback verification planned for TASK 06-B.
 */

const MIGRATION_PATH =
  process.env.BUSINESS_MIGRATION_PATH ??
  path.resolve(__dirname, "../../supabase/migrations/20261108000000_business_backend.sql");

const rawSql = readFileSync(MIGRATION_PATH, "utf8");
// Strip line comments so wording in comments cannot satisfy or violate a check.
const sql = rawSql
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

const TABLES = ["businesses", "business_members", "business_verifications", "business_hours"];

function statements(): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function grants(): string[] {
  return statements().filter((s) => /^grant\s/.test(s));
}

function policies(): Array<{ name: string; table: string; text: string }> {
  return statements()
    .filter((s) => /^create policy\s/.test(s))
    .map((text) => {
      const m = /create policy\s+"([^"]+)"\s+on\s+public\.(\w+)/.exec(text);
      return { name: m?.[1] ?? "", table: m?.[2] ?? "", text };
    });
}

function columnList(grantStmt: string): string[] {
  const m = /\(([^)]*)\)\s*on\s+public\./.exec(grantStmt);
  return (m?.[1] ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

describe("TASK 06-A migration static security checks", () => {
  it("only the TASK 06 migration is new on top of the two applied ones", () => {
    expect(sql).toContain("create table if not exists public.businesses");
    expect(sql).not.toMatch(/drop\s+table|truncate|delete\s+from|drop\s+schema|drop\s+column/);
  });

  it("enables RLS and revokes all default privileges on every table", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`alter table public.${t} enable row level security`);
      expect(sql).toMatch(
        new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`)
      );
    }
  });

  it("never grants anything to anon or PUBLIC", () => {
    for (const g of grants()) {
      expect(g).not.toMatch(/\bto\b[^;]*\banon\b/);
      expect(g).not.toMatch(/\bto\b[^;]*\bpublic\b/);
    }
  });

  it("does not let authenticated INSERT into businesses, business_members or business_verifications", () => {
    for (const g of grants()) {
      if (!/\bto\b[^;]*\bauthenticated\b/.test(g)) continue;
      if (/\bon public\.(businesses|business_members|business_verifications)\b/.test(g)) {
        expect(g).not.toMatch(/^grant\s+(select,\s*)?insert\b/);
        expect(g).not.toMatch(/\binsert\b/);
        expect(g).not.toMatch(/\bdelete\b/);
      }
    }
    // no INSERT policies on those tables either
    for (const p of policies()) {
      if (["businesses", "business_members", "business_verifications"].includes(p.table)) {
        expect(p.text).not.toMatch(/\bfor insert\b/);
      }
    }
  });

  it("limits authenticated UPDATE on businesses to non-approval columns", () => {
    const updateGrants = grants().filter(
      (g) => /\bupdate\b/.test(g) && /on public\.businesses\b/.test(g) && /\bauthenticated\b/.test(g)
    );
    expect(updateGrants).toHaveLength(1);
    const cols = columnList(updateGrants[0] ?? "");
    expect(cols.length).toBeGreaterThan(0);
    for (const protectedCol of [
      "id",
      "registration_status",
      "approved_by",
      "approved_at",
      "rejection_reason",
      "created_by",
      "created_at",
      "updated_at",
    ]) {
      expect(cols).not.toContain(protectedCol);
    }
    // must be column-level, not table-level
    expect(updateGrants[0]).toMatch(/^grant update\s*\(/);
  });

  it("grants no UPDATE/DELETE on business_members and no table-level SELECT on business_verifications to authenticated", () => {
    const memberGrants = grants().filter(
      (g) => /on public\.business_members\b/.test(g) && /\bauthenticated\b/.test(g)
    );
    for (const g of memberGrants) {
      expect(g).not.toMatch(/\b(insert|update|delete)\b/);
    }

    const verifGrants = grants().filter(
      (g) => /on public\.business_verifications\b/.test(g) && /\bauthenticated\b/.test(g)
    );
    expect(verifGrants).toHaveLength(1);
    expect(verifGrants[0]).toMatch(/^grant select\s*\(/);
    const cols = columnList(verifGrants[0] ?? "");
    for (const privateCol of [
      "registration_number",
      "evidence_storage_path",
      "review_notes",
      "reviewed_by",
    ]) {
      expect(cols).not.toContain(privateCol);
    }
  });

  it("every table that clients can touch has at least one RLS policy for authenticated", () => {
    for (const t of TABLES) {
      const tablePolicies = policies().filter((p) => p.table === t);
      expect(tablePolicies.length).toBeGreaterThan(0);
      for (const p of tablePolicies) {
        expect(p.text).toMatch(/\bto authenticated\b/);
      }
    }
  });

  it("no RLS policy queries its own table (avoids infinite recursion)", () => {
    for (const p of policies()) {
      expect(p.text, `policy ${p.name} references ${p.table}`).not.toMatch(
        new RegExp(`(from|join)\\s+public\\.${p.table}\\b`)
      );
      // policies must not embed raw subqueries on the membership table at all
      expect(p.text).not.toMatch(/\bfrom public\.business_members\b/);
    }
  });

  it("businesses select policy does not expose rows to every authenticated user", () => {
    const selectPolicy = policies().find((p) => p.name === "businesses_select_policy");
    expect(selectPolicy).toBeDefined();
    expect(selectPolicy?.text).not.toContain("registration_status = 'approved'");
    expect(selectPolicy?.text).toContain("is_business_member");
  });

  it("verification select policy is restricted to admin or the submitting member", () => {
    const p = policies().find((x) => x.name === "business_verifications_select_policy");
    expect(p?.text).toContain("is_admin(auth.uid())");
    expect(p?.text).toContain("submitted_by = auth.uid()");
  });

  it("every SECURITY DEFINER function pins search_path and restricts EXECUTE", () => {
    const defs: Array<{ name: string; body: string }> = sql
      .split("create or replace function ")
      .slice(1)
      .map((chunk) => {
        const nameMatch = /^public\.(\w+)\s*\(/.exec(chunk);
        return { name: nameMatch?.[1] ?? "", body: chunk };
      });
    const definers = defs.filter((d) => /security definer/.test(d.body));
    expect(definers.map((d) => d.name).sort()).toEqual(
      [
        "can_edit_business",
        "create_business_with_owner",
        "is_approved_business_member",
        "is_business_member",
        "submit_business_for_review",
      ].sort()
    );
    for (const d of definers) {
      expect(d.body, `${d.name} search_path`).toMatch(/set search_path = public, pg_temp/);
      expect(sql, `${d.name} revoke`).toMatch(
        new RegExp(`revoke all on function public\\.${d.name}\\([^)]*\\)\\s+from public, anon, authenticated`)
      );
      expect(sql, `${d.name} grant`).toMatch(
        new RegExp(`grant execute on function public\\.${d.name}\\([^)]*\\)\\s+to authenticated, service_role`)
      );
    }
  });

  it("membership helpers accept no user id parameter (caller-only, no UUID enumeration)", () => {
    for (const name of ["is_business_member", "is_approved_business_member", "can_edit_business"]) {
      const m = new RegExp(`function public\\.${name}\\(([^)]*)\\)`).exec(sql);
      expect(m?.[1]).toBeDefined();
      expect(m?.[1]).not.toMatch(/user/);
      expect(sql).toMatch(/auth\.uid\(\)/);
    }
  });

  it("registration RPCs derive the creator from auth.uid() and take no identity/status params", () => {
    const create = /create or replace function public\.create_business_with_owner\(([\s\S]*?)\)\s*returns/.exec(
      sql
    );
    expect(create?.[1]).toBeDefined();
    for (const forbidden of ["user_id", "created_by", "status", "role", "approved"]) {
      expect(create?.[1]).not.toContain(forbidden);
    }
    expect(sql).toContain("v_uid uuid := auth.uid()");
    expect(sql).toContain("raise exception 'unauthenticated'");
  });

  it("creation is atomic: business + first owner + verification happen in one function", () => {
    const start = sql.indexOf("function public.create_business_with_owner");
    const end = sql.indexOf("function public.submit_business_for_review");
    const body = sql.slice(start, end);
    expect(body).toContain("insert into public.businesses");
    expect(body).toContain("insert into public.business_members");
    expect(body).toContain("insert into public.business_verifications");
    expect(body).toContain("'draft'");
    expect(body).toContain("'owner'");
    expect(body).not.toMatch(/\bcommit\b|\bexception\s+when\b/);
    // owner is always the creator, never a caller-supplied user
    expect(body).toMatch(/values \(v_business\.id, v_uid, 'owner', 'active'\)/);
  });

  it("the migration never writes user_roles (no automatic merchant grant)", () => {
    expect(sql).not.toContain("user_roles");
    expect(sql).not.toMatch(/'merchant'/);
  });

  it("submit RPC is owner-only, row-locked and only transitions draft/rejected -> pending", () => {
    const start = sql.indexOf("function public.submit_business_for_review");
    const end = sql.indexOf("revoke all on function public.create_business_with_owner");
    const body = sql.slice(start, end);
    expect(body).toContain("is_business_member(p_business_id, true)");
    expect(body).toContain("for update");
    expect(body).toContain("registration_status = 'pending'");
    expect(body).toMatch(/not in \('draft', 'rejected'\)/);
    expect(body).not.toContain("'approved',");
  });

  it("protects approval columns with a BEFORE UPDATE trigger on businesses", () => {
    expect(sql).toContain("create trigger enforce_businesses_update_rules");
    expect(sql).toMatch(/before update on public\.businesses/);
    for (const col of [
      "registration_status",
      "approved_by",
      "approved_at",
      "rejection_reason",
      "created_by",
    ]) {
      expect(sql).toContain(`new.${col} is distinct from old.${col}`);
    }
  });

  it("restricts changes to core approval fields (name, category, address, coords) on approved businesses in the trigger", () => {
    expect(sql).toContain("old.registration_status = 'approved'");
    for (const coreCol of [
      "name",
      "category",
      "road_address",
      "jibun_address",
      "address_detail",
      "latitude",
      "longitude",
    ]) {
      expect(sql).toContain(`new.${coreCol} is distinct from old.${coreCol}`);
    }
  });

  it("keeps approval consistency constraints and FK to business_leads", () => {
    expect(sql).toContain("chk_businesses_approved_has_time");
    expect(sql).toContain("chk_businesses_unapproved_no_approval");
    expect(sql).toContain("fk_business_leads_converted_business");
    expect(sql).toContain("references public.profiles(id) on delete restrict");
  });
});
