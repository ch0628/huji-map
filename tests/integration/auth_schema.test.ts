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

  it("일반 사용자가 자신의 profiles.account_status를 임의 변경해 정지 상태를 해제할 수 없도록 차단해야 한다", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.protect_profile_sensitive_columns\(\)/);
    expect(sql).toMatch(/NEW\.account_status IS DISTINCT FROM OLD\.account_status/);
    expect(sql).toMatch(/USING \(auth\.uid\(\) = id AND account_status = 'active'\)/);
    expect(sql).toMatch(/WITH CHECK \(auth\.uid\(\) = id AND account_status = 'active'\)/);
  });

  it("SECURITY DEFINER 함수의 실행 권한 통제 및 타인 관리자 여부 열거 방지가 적용되어야 한다", () => {
    expect(sql).toMatch(/WHEN auth\.uid\(\) IS NOT NULL AND target_user_id <> auth\.uid\(\) THEN false/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.handle_new_user\(\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.handle_new_user\(\) TO postgres, service_role, supabase_auth_admin;/
    );
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
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => createClient()).toThrow(/Supabase browser client configuration is missing/);
  });

  it("환경변수 누락 시 서버 어드민 클라이언트 생성 시 명시적인 오류를 발생시켜야 한다", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
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

  it("최신 publishable 키 체계(NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)로도 브라우저 클라이언트를 초기화할 수 있어야 한다", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "dummy-publishable-key";

    const client = createClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it("공식 @supabase/supabase-js 패키지를 통해 서버 어드민 클라이언트를 정상 초기화할 수 있어야 한다", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";

    const adminClient = createAdminClient();
    expect(adminClient).toBeDefined();
    expect(adminClient.auth).toBeDefined();
    expect(typeof adminClient.from).toBe("function");
  });

  it("최신 secret 키 체계(SUPABASE_SECRET_KEY)로도 서버 어드민 클라이언트를 초기화할 수 있어야 한다", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SECRET_KEY = "dummy-secret-key";

    const adminClient = createAdminClient();
    expect(adminClient).toBeDefined();
    expect(adminClient.auth).toBeDefined();
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

  it(".env.local에 설정된 실제 프로젝트 URL 및 Publishable Key로 SDK 클라이언트가 정상 생성되어야 한다", () => {
    const envLocalPath = path.resolve(process.cwd(), ".env.local");
    if (fs.existsSync(envLocalPath)) {
      const content = fs.readFileSync(envLocalPath, "utf-8");
      const parsed: Record<string, string> = {};
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx > 0) {
          parsed[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
        }
      }

      expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toMatch(/^https:\/\/[a-z0-9]{20}\.supabase\.co$/);
      expect(parsed.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);

      process.env.NEXT_PUBLIC_SUPABASE_URL = parsed.NEXT_PUBLIC_SUPABASE_URL;
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
        parsed.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const client = createClient();
      expect(client).toBeDefined();
      expect(client.auth).toBeDefined();
    }
  });
});

describe("TASK 03-B3 - pgTAP & Self-Rolling-Back SQL Verification Suite Safety Check", () => {
  const pgtapPath = path.resolve(
    process.cwd(),
    "tests/integration/sql/auth_rls.pgtap.sql"
  );
  const rollbackSqlPath = path.resolve(
    process.cwd(),
    "tests/integration/sql/verify_auth_rls_rollback.sql"
  );

  let pgtapSql = "";
  let rollbackSql = "";

  beforeEach(() => {
    pgtapSql = fs.readFileSync(pgtapPath, "utf-8");
    rollbackSql = fs.readFileSync(rollbackSqlPath, "utf-8");
  });

  it("프로젝트 내부 테스트 폴더(tests/integration/sql/)에 공식 pgTAP 및 단일문 롤백 검증 SQL이 존재해야 한다", () => {
    expect(fs.existsSync(pgtapPath)).toBe(true);
    expect(fs.existsSync(rollbackSqlPath)).toBe(true);
    expect(pgtapSql.length).toBeGreaterThan(0);
    expect(rollbackSql.length).toBeGreaterThan(0);
  });

  it("검증 SQL이 실제 마이그레이션(20261106000000_auth_schema.sql)의 컬럼명 및 제약조건과 정확히 일치해야 한다", () => {
    for (const content of [pgtapSql, rollbackSql]) {
      // 잘못된 구 스키마 컬럼명이 없어야 함
      expect(content).not.toMatch(/profiles\s+WHERE\s+user_id/i);
      expect(content).not.toMatch(/anon_session_hash/i);
      expect(content).not.toMatch(/terms_of_service/i);

      // 실제 스키마 컬럼 및 제약조건 값 사용 확인
      expect(content).toMatch(/public\.profiles[\s\S]*?WHERE\s+id\s*=/);
      expect(content).toMatch(
        /public\.visitor_sessions\s*\(id,\s*browser_id,\s*user_id,\s*landing_path,\s*device_type,\s*is_test\)/
      );
      expect(content).toMatch(
        /public\.consent_records\s*\(id,\s*user_id,\s*browser_id,\s*consent_type,\s*policy_version,\s*accepted\)/
      );
      expect(content).toMatch(/public\.feature_flags\s*\(key,\s*enabled,\s*config\)/);
    }
  });

  it("검증 그룹 증가 횟수(v_pass_count)와 기대 횟수(v_expected_pass_count) 및 pgTAP plan 횟수가 정확히 일치해야 한다", () => {
    const increments = rollbackSql.match(/v_pass_count\s*:=\s*v_pass_count\s*\+\s*1\s*;/g) ?? [];
    const expectedMatch = rollbackSql.match(/v_expected_pass_count\s+CONSTANT\s+int\s*:=\s*(\d+)\s*;/);
    expect(expectedMatch).not.toBeNull();
    const expectedCount = Number(expectedMatch![1]);
    expect(increments.length).toBe(15);
    expect(expectedCount).toBe(increments.length);
    expect(rollbackSql).toMatch(/IF\s+v_pass_count\s*<>\s*v_expected_pass_count\s+THEN/);

    const planMatch = pgtapSql.match(/SELECT\s+plan\((\d+)\)\s*;/);
    expect(planMatch).not.toBeNull();
    const plannedTests = Number(planMatch![1]);
    const pgtapAssertions =
      pgtapSql.match(/SELECT\s+(?:is|throws_ok|lives_ok)\s*\(/g) ?? [];
    expect(pgtapAssertions.length).toBe(18);
    expect(plannedTests).toBe(pgtapAssertions.length);
  });

  it("신규 회원 기본 권한 확인 이후 u2에 admin을 부여하고, 서버/본인 확인(true)과 타인(u1)의 is_admin(u2) 열거 차단(false)을 구분 검증해야 한다", () => {
    for (const content of [pgtapSql, rollbackSql]) {
      // 1) 신규 회원 기본 권한 확인 시 admin/merchant 미부여 먼저 검증
      const idxNoAutoAdmin = content.indexOf("role IN ('admin', 'merchant')");
      // 2) 이후 u2에게 admin 권한 부여
      const idxGrantAdminU2 = content.indexOf(
        "INSERT INTO public.user_roles (user_id, role, granted_by)"
      );
      // 3) 일반 사용자 u1 컨텍스트 전환 후 is_admin(u2) 열거 차단 검증
      const idxU1RoleSwitch = content.indexOf("SET LOCAL ROLE authenticated;");
      const idxEnumerationCheck = content.lastIndexOf("public.is_admin(");

      expect(idxNoAutoAdmin).toBeGreaterThan(0);
      expect(idxGrantAdminU2).toBeGreaterThan(idxNoAutoAdmin);
      expect(idxU1RoleSwitch).toBeGreaterThan(idxNoAutoAdmin);
      expect(idxEnumerationCheck).toBeGreaterThan(idxU1RoleSwitch);
    }

    // rollbackSql에서 서버/u2 본인은 true, u1은 false를 모두 검증하는지 확인
    expect(rollbackSql).toMatch(/FAIL \[C-1a\]: expected is_admin\(u2\)=true in server context/);
    expect(rollbackSql).toMatch(/FAIL \[C-1a\]: expected is_admin\(u2\)=true when called by u2 self/);
    expect(rollbackSql).toMatch(/FAIL \[C-1b\]: is_admin\(u2\) returned % to non-owner u1/);
  });

  it("차단 검증 시 UPDATE/DELETE 0행 처리와 42501 권한 거부만 정상 차단으로 판정하고 예상치 못한 예외는 통과시키지 않아야 한다", () => {
    // WHEN OTHERS 사용 금지 (예상치 못한 SQL 오류를 PASS로 둔갑시키지 않음)
    expect(rollbackSql).not.toMatch(/WHEN\s+OTHERS/i);

    // 보호 트리거 예외(raise_exception) 검사 시 정확한 Forbidden 메시지 확인 후 불일치 시 RAISE 재발생
    const raiseExceptionHandlers =
      rollbackSql.match(/WHEN raise_exception THEN[\s\S]*?END IF;/g) ?? [];
    expect(raiseExceptionHandlers.length).toBe(2);
    for (const handler of raiseExceptionHandlers) {
      expect(handler).toMatch(
        /IF SQLERRM LIKE '%Forbidden: account_status and created_at can only be modified by server or admin%' THEN/
      );
      expect(handler).toMatch(/ELSE\s+RAISE;/);
    }

    // UPDATE/DELETE 차단 블록에서 ROW_COUNT = 0 과 insufficient_privilege(42501) 모두 수용 확인
    const dualBlockChecks =
      rollbackSql.match(
        /GET DIAGNOSTICS v_cnt = ROW_COUNT;\s*IF v_cnt = 0 THEN\s*v_blocked := true;\s*END IF;\s*EXCEPTION\s*WHEN insufficient_privilege THEN\s*v_blocked := true;/g
      ) ?? [];
    expect(dualBlockChecks.length).toBeGreaterThanOrEqual(7);
  });

  it("SET LOCAL ROLE authenticated와 사용자별 JWT claim(sub, role)을 정확히 설정해야 한다", () => {
    expect(pgtapSql).toMatch(/SET LOCAL ROLE authenticated;/);
    expect(pgtapSql).toMatch(
      /SET LOCAL "request\.jwt\.claims" = '\{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"\}';/
    );

    expect(rollbackSql).toMatch(/SET LOCAL ROLE authenticated;/);
    expect(rollbackSql).toMatch(
      /perform set_config\(\s*'request\.jwt\.claims',\s*json_build_object\('sub', u1::text, 'role', 'authenticated'\)::text,\s*true\s*\);/i
    );
  });

  it("허용되어야 하는 동작과 차단되어야 하는 동작을 모두 검사해야 한다", () => {
    for (const content of [pgtapSql, rollbackSql]) {
      // 허용 동작: 회원 생성 트리거(profiles, customer 역할), 본인 프로필 수정, 본인 세션/동의 INSERT
      expect(content).toMatch(/INSERT INTO auth\.users/);
      expect(content).toMatch(/role = 'customer'/);
      expect(content).toMatch(/UPDATE public\.profiles[\s\S]*?SET display_name = 'DEMO_TEST_U1_UPDATED'/);
      expect(content).toMatch(/INSERT INTO public\.visitor_sessions/);
      expect(content).toMatch(/INSERT INTO public\.consent_records/);

      // 차단 동작: 타인 프로필 수정, 타인 권한 변경, admin 자가 추가(42501), 민감 컬럼 변경(P0001), is_admin 열거, handle_new_user 실행 권한
      expect(content).toMatch(/HACKED_U2/);
      expect(content).toMatch(/INSERT INTO public\.user_roles \(user_id, role\) VALUES \([^)]*'admin'\)/);
      expect(content).toMatch(/UPDATE public\.profiles SET account_status = 'suspended'/);
      expect(content).toMatch(/UPDATE public\.profiles SET created_at =/);
      expect(content).toMatch(/public\.is_admin\(/);
      expect(content).toMatch(/has_function_privilege\('authenticated', 'public\.handle_new_user\(\)', 'EXECUTE'\)/);
    }
  });

  it("모든 대상 테이블의 사전 충돌 검사(Pre-check)와 롤백 후 잔류 0건 검사(Post-check)가 포함되어야 한다", () => {
    expect(pgtapSql).toMatch(/^[\s\S]*?BEGIN;[\s\S]*?SELECT \* FROM finish\(\);[\s\S]*?ROLLBACK;\s*$/);

    expect(rollbackSql).toMatch(/^(?:\s*--[^\r\n]*\r?\n|\s)*DO \$verify\$[\s\S]*?\$verify\$;\s*$/);
    expect(rollbackSql).toMatch(/RAISE EXCEPTION USING ERRCODE = 'P0099'/);
    expect(rollbackSql).toMatch(/WHEN SQLSTATE 'P0099' THEN/);

    // 6개 테이블 모두에 대해 PRECHECK_ABORT 및 POSTCHECK_FAIL 검사 존재 확인
    for (const tableName of [
      "auth.users",
      "public.profiles",
      "public.user_roles",
      "public.visitor_sessions",
      "public.consent_records",
      "public.feature_flags",
    ]) {
      expect(rollbackSql).toContain(
        `PRECHECK_ABORT: synthetic test identifier already exists in ${tableName}`
      );
      expect(rollbackSql).toContain(
        `POSTCHECK_FAIL: % test rows remain in ${tableName} after rollback`
      );
    }

    // PL/pgSQL BEGIN ~ END; 블록 균형 검사
    const strippedComments = rollbackSql.replace(/--[^\r\n]*/g, "");
    const beginCount = (strippedComments.match(/\bBEGIN\b/g) ?? []).length;
    const endBlockCount = (strippedComments.match(/\bEND\s*;/g) ?? []).length;
    expect(beginCount).toBe(endBlockCount);

    for (const content of [pgtapSql, rollbackSql]) {
      expect(content).not.toMatch(/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|PGPASSWORD/);
      expect(content).toMatch(/@example\.invalid/);
    }
  });
});
