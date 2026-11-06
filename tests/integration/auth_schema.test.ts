import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getAuthUser,
  getUserRoles,
  hasRole,
  isAdmin,
  isMerchant,
  getVerifiedAuthContext,
} from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/client";
import { createAdminClient } from "@/lib/supabase/server";

describe("TASK 03 - Auth Schema & RLS SQL Migration Verification", () => {
  const migrationPath = path.resolve(
    process.cwd(),
    "supabase/migrations/20261106000000_auth_schema.sql"
  );
  let sql = "";

  beforeEach(() => {
    sql = fs.readFileSync(migrationPath, "utf-8");
  });

  it("마이그레이션 파일이 존재해야 한다", () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(sql.length).toBeGreaterThan(0);
  });

  it("필수 5개 테이블이 모두 정의되어 있어야 한다 (profiles, user_roles, visitor_sessions, consent_records, feature_flags)", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.profiles/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.user_roles/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.visitor_sessions/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.consent_records/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.feature_flags/);
  });

  it("각 테이블의 기본키(PK) 및 외래키(FK) 제약조건이 올바르게 정의되어야 한다", () => {
    // profiles: PK, FK to auth.users
    expect(sql).toMatch(/id uuid PRIMARY KEY REFERENCES auth\.users\(id\)/);

    // user_roles: Composite PK, FK to profiles
    expect(sql).toMatch(/user_id uuid NOT NULL REFERENCES public\.profiles\(id\)/);
    expect(sql).toMatch(/PRIMARY KEY \(user_id, role\)/);

    // visitor_sessions: PK, FK to profiles (nullable)
    expect(sql).toMatch(/id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(sql).toMatch(/user_id uuid NULL REFERENCES public\.profiles\(id\)/);

    // consent_records: PK, FK to profiles (nullable)
    expect(sql).toMatch(/user_id uuid NULL REFERENCES public\.profiles\(id\)/);
    expect(sql).toMatch(/CONSTRAINT chk_consent_subject CHECK/);

    // feature_flags: text PK
    expect(sql).toMatch(/key text PRIMARY KEY/);
  });

  it("모든 상태값에 대해 CHECK 제약조건이 적용되어야 한다", () => {
    // account_status
    expect(sql).toMatch(
      /CHECK \(account_status IN \('active', 'suspended', 'deleted'\)\)/
    );
    // role
    expect(sql).toMatch(
      /CHECK \(role IN \('customer', 'merchant', 'admin'\)\)/
    );
    // device_type
    expect(sql).toMatch(
      /CHECK \(device_type IN \('mobile', 'tablet', 'desktop', 'unknown'\)\)/
    );
    // consent_type
    expect(sql).toMatch(
      /CHECK \(consent_type IN \('terms', 'privacy', 'analytics', 'marketing'\)\)/
    );
  });

  it("5개 테이블 모두에 Row Level Security (RLS)가 활성화되어야 한다", () => {
    expect(sql).toMatch(/ALTER TABLE public\.profiles ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/ALTER TABLE public\.user_roles ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(
      /ALTER TABLE public\.visitor_sessions ENABLE ROW LEVEL SECURITY;/
    );
    expect(sql).toMatch(
      /ALTER TABLE public\.consent_records ENABLE ROW LEVEL SECURITY;/
    );
    expect(sql).toMatch(
      /ALTER TABLE public\.feature_flags ENABLE ROW LEVEL SECURITY;/
    );
  });

  it("handle_new_user() 함수는 SECURITY DEFINER와 안전한 search_path를 적용하고 기본 role을 customer로 설정해야 한다", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public, auth, pg_temp/);

    // Default role 'customer'
    expect(sql).toMatch(
      /INSERT INTO public\.user_roles \(user_id, role, granted_by\)[\s\S]*?'customer'/
    );

    // Should NOT grant admin role automatically
    expect(sql).not.toMatch(
      /INSERT INTO public\.user_roles \(user_id, role, granted_by\)[\s\S]*?'admin'/
    );
  });

  it("user_roles에 대한 RLS 정책은 일반 사용자의 admin 임의 변경을 차단해야 한다", () => {
    expect(sql).toMatch(/CREATE POLICY "user_roles_admin_manage"/);
    expect(sql).toMatch(/public\.is_admin\(auth\.uid\(\)\)/);
  });
});

describe("TASK 03 - Supabase Official SDK & Auth Helpers Unit Verification", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("환경변수 누락 시 브라우저 클라이언트 생성 시 명시적인 오류를 발생시켜야 한다", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => createClient()).toThrow(/Supabase browser client configuration is missing/);
  });

  it("환경변수 누락 시 서버 어드민 클라이언트 생성 시 명시적인 오류를 발생시켜야 한다", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => createAdminClient()).toThrow(/Supabase admin client configuration is missing/);
  });

  it("공식 @supabase/ssr 패키지를 통해 브라우저 클라이언트를 정상 초기화할 수 있어야 한다", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dummy-anon-key";

    const client = createClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
    expect(typeof client.auth.getUser).toBe("function");
    expect(typeof client.from).toBe("function");
  });

  it("공식 @supabase/supabase-js 패키지를 통해 서버 어드민 클라이언트를 정상 초기화할 수 있어야 한다", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";

    const adminClient = createAdminClient();
    expect(adminClient).toBeDefined();
    expect(adminClient.auth).toBeDefined();
    expect(typeof adminClient.from).toBe("function");
  });

  it("클라이언트 윈도우 환경에서 createAdminClient 호출 시 즉시 보안 예외를 던져야 한다", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";

    // Simulate browser window
    (globalThis as any).window = {};

    try {
      expect(() => createAdminClient()).toThrow(/SECURITY VIOLATION/);
    } finally {
      delete (globalThis as any).window;
    }
  });

  it("getAuthUser()는 Supabase auth.getUser()를 호출하여 사용자를 검증해야 한다", async () => {
    const mockUser = {
      id: "test-user-uuid",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    };

    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: mockUser },
          error: null,
        }),
        getSession: vi.fn(),
        signOut: vi.fn(),
      },
      from: vi.fn(),
    };

    const user = await getAuthUser(mockSupabase as any);
    expect(mockSupabase.auth.getUser).toHaveBeenCalledOnce();
    expect(user).toEqual(mockUser);
  });

  it("getUserRoles()는 사용자의 권한 목록을 안전하게 반환해야 한다", async () => {
    const mockEq = vi.fn().mockResolvedValue({
      data: [{ role: "customer" }, { role: "merchant" }],
      error: null,
    });
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
    const mockSupabase = {
      auth: { getUser: vi.fn(), getSession: vi.fn(), signOut: vi.fn() },
      from: vi.fn().mockReturnValue({ select: mockSelect }),
    };

    const roles = await getUserRoles(mockSupabase as any, "user-123");
    expect(roles).toEqual(["customer", "merchant"]);
    expect(await hasRole(mockSupabase as any, "user-123", "merchant")).toBe(true);
    expect(await isAdmin(mockSupabase as any, "user-123")).toBe(false);
  });

  it("getVerifiedAuthContext()는 인증 사용자 정보와 권한 플래그를 정확하게 집계해야 한다", async () => {
    const mockUser = {
      id: "admin-user-uuid",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    };

    const mockEq = vi.fn().mockResolvedValue({
      data: [{ role: "customer" }, { role: "admin" }],
      error: null,
    });
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });

    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: mockUser },
          error: null,
        }),
        getSession: vi.fn(),
        signOut: vi.fn(),
      },
      from: vi.fn().mockReturnValue({ select: mockSelect }),
    };

    const ctx = await getVerifiedAuthContext(mockSupabase as any);
    expect(ctx.user).toEqual(mockUser);
    expect(ctx.roles).toEqual(["customer", "admin"]);
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.isMerchant).toBe(false);
  });
});
